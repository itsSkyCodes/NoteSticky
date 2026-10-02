// NoteSticky - Content Script (Encapsulated in Shadow DOM)

(() => {
  // Prevent duplicate injection across both isolated and main worlds
  if (window.__notesticky_injected__ || (document.documentElement && document.documentElement.hasAttribute('data-notesticky-injected'))) {
    return;
  }
  window.__notesticky_injected__ = true;
  if (document.documentElement) {
    document.documentElement.setAttribute('data-notesticky-injected', 'true');
  }

  // Global state for content script
  let shadowRoot = null;
  let canvasEl = null;
  let fabEl = null;
  let notesMap = new Map(); // id -> DOM Element
  let notesData = []; // cached list from storage
  let currentSettings = {
    notesVisible: true,
    defaultColor: 'yellow',
    showFloatingButton: true,
    pinMode: 'page',
    fabMinimized: false
  };
  let highestZIndex = 10;
  let lastHiddenNoteId = null;
  let lastActiveNoteId = null;
  let hiddenNotesStack = [];
  let saveTimeouts = new Map();
  let lastDeletedNote = null;
  let undoToastTimeout = null;

  const extractDomain = (url) => {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (parsed.hostname) return parsed.hostname.toLowerCase();
      if (parsed.protocol === 'file:') return 'local-file';
      return (parsed.origin || '').toLowerCase();
    } catch (_) {
      return '';
    }
  };

  const getCurrentUrl = () => window.location.href.split('#')[0];
  const getCurrentDomain = () => {
    const host = window.location.hostname;
    if (host) return host.toLowerCase();
    if (window.location.protocol === 'file:') return 'local-file';
    return (window.location.origin || 'local').toLowerCase();
  };
  const getPageTitle = () => document.title || getCurrentDomain();

  const isNoteOnCurrentDomain = (note) => {
    if (!note) return false;
    const currentDom = getCurrentDomain();
    if (!currentDom) return false;
    const noteDom = (note.domain || extractDomain(note.url) || '').toLowerCase();
    return noteDom === currentDom;
  };

  // Normalize z-indexes to prevent unbounded growth and integer overflow
  function normalizeZIndices() {
    const sorted = [...notesData].sort((a, b) => (parseInt(a.zIndex, 10) || 0) - (parseInt(b.zIndex, 10) || 0));
    sorted.forEach((n, idx) => {
      n.zIndex = 10 + (idx * 2);
      const el = notesMap.get(n.id);
      if (el) el.style.zIndex = n.zIndex;
    });
    highestZIndex = sorted.length > 0 ? (10 + (sorted.length * 2)) : 10;
  }

  // Initialize Shadow DOM Container
  function initContainer() {
    let host = document.getElementById('notesticky-root');
    if (host) {
      if (host.shadowRoot) {
        shadowRoot = host.shadowRoot;
        return; // Shadow DOM already initialized on this host
      }
      try {
        host.remove();
      } catch (e) {}
    }

    host = document.createElement('div');
    host.id = 'notesticky-root';

    // Apply strict inline reset styles to host element to prevent any layout interference
    host.style.cssText = [
      'position: absolute !important',
      'top: 0px !important',
      'left: 0px !important',
      'width: 0px !important',
      'height: 0px !important',
      'margin: 0px !important',
      'padding: 0px !important',
      'border: none !important',
      'outline: none !important',
      'background: transparent !important',
      'overflow: visible !important',
      'pointer-events: none !important',
      'z-index: 2147483647 !important',
      'display: block !important',
      'visibility: visible !important',
      'opacity: 1 !important',
      'box-shadow: none !important',
      'transform: none !important',
      'contain: none !important',
      'float: none !important',
      'clear: none !important',
      'line-height: normal !important'
    ].join('; ');

    // Prefer document.documentElement (<html>) so the host element never participates in
    // body flex/grid/column layouts or conflicts with body-level child selectors
    const targetParent = document.documentElement || document.body;
    targetParent.appendChild(host);

    try {
      shadowRoot = host.attachShadow({ mode: 'open' });
    } catch (e) {
      if (host.shadowRoot) {
        shadowRoot = host.shadowRoot;
        return;
      }
      console.warn('NoteSticky: attachShadow failed', e);
      return;
    }

    // Critical reset / positioning styles inside Shadow DOM to eliminate any FOUC before link loads
    const criticalStyle = document.createElement('style');
    criticalStyle.textContent = `
      :host {
        all: initial !important;
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 0 !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        outline: none !important;
        background: transparent !important;
        overflow: visible !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        display: block !important;
        box-sizing: border-box !important;
      }
      .notesticky-canvas {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 0 !important;
        height: 0 !important;
        overflow: visible !important;
        pointer-events: none !important;
        z-index: 2147483640 !important;
      }
    `;
    shadowRoot.appendChild(criticalStyle);

    // Link the external CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content/content.css');
    shadowRoot.appendChild(link);

    // Canvas container
    canvasEl = document.createElement('div');
    canvasEl.className = 'notesticky-canvas';
    shadowRoot.appendChild(canvasEl);

    // Floating action button
    createFab();

    // Single delegated listener for dismissing open color palettes across Shadow DOM without memory leaks
    document.addEventListener('pointerdown', (e) => {
      if (!shadowRoot) return;
      const openPalettes = shadowRoot.querySelectorAll('.palette-popover.open');
      if (openPalettes.length === 0) return;

      const path = e.composedPath();
      openPalettes.forEach(popover => {
        const noteEl = popover.closest('.sticky-note');
        const paletteBtn = noteEl ? noteEl.querySelector('#btn-palette') : null;
        if (!path.includes(popover) && (!paletteBtn || !path.includes(paletteBtn))) {
          popover.classList.remove('open');
        }
      });
    });

    // Dismiss open popovers and undo toasts on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!shadowRoot) return;

      let handled = false;

      // 1. Close open palette popovers
      const openPalettes = shadowRoot.querySelectorAll('.palette-popover.open');
      if (openPalettes.length > 0) {
        openPalettes.forEach(popover => {
          popover.classList.remove('open');
          const noteEl = popover.closest('.sticky-note');
          const paletteBtn = noteEl ? noteEl.querySelector('#btn-palette') : null;
          if (paletteBtn) paletteBtn.focus();
        });
        handled = true;
      }

      // 2. Close FAB context popover
      if (fabEl) {
        const fabPopover = fabEl.querySelector('#fab-notes-popover.open');
        if (fabPopover) {
          fabPopover.classList.remove('open');
          const toggleBtn = fabEl.querySelector('#fab-toggle-btn');
          if (toggleBtn) toggleBtn.focus();
          handled = true;
        }
      }

      // 3. Dismiss undo toast
      const toast = shadowRoot.querySelector('.notesticky-toast');
      if (toast) {
        toast.remove();
        if (undoToastTimeout) clearTimeout(undoToastTimeout);
        lastDeletedNote = null;
        handled = true;
      }

      if (handled) {
        const path = e.composedPath ? e.composedPath() : [];
        const isEventInside = path.some(node => node === host || node === shadowRoot);
        if (isEventInside) {
          e.stopPropagation();
        }
      }
    });

    // Load initial data
    loadFromStorage();
  }

  // Load notes & settings from chrome.storage
  function loadFromStorage() {
    chrome.storage.local.get(['notes', 'settings'], (res) => {
      if (res.settings) {
        currentSettings = { ...currentSettings, ...res.settings };
      }
      notesData = res.notes || [];

      // Normalize legacy/overflow z-indexes if present from prior versions
      const hasLegacyZIndex = notesData.some(n => {
        const z = parseInt(n.zIndex, 10);
        return isNaN(z) || z >= 100000;
      });

      if (hasLegacyZIndex) {
        normalizeZIndices();
        saveNotesToStorage();
      } else {
        let maxZ = 10;
        notesData.forEach(n => {
          const z = parseInt(n.zIndex, 10);
          if (!isNaN(z) && z > maxZ) {
            maxZ = z;
          }
        });
        highestZIndex = maxZ;
      }

      renderCurrentPageNotes();
      updateFabBadge();
      updateFabButtonState();
      updateFabVisibility();
    });
  }

  // Listen for storage changes from other tabs or popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.settings) {
      currentSettings = { ...currentSettings, ...changes.settings.newValue };
      updateFabVisibility();
      if (canvasEl) {
        canvasEl.style.display = currentSettings.notesVisible ? 'block' : 'none';
      }
    }

    if (changes.notes) {
      notesData = changes.notes.newValue || [];
      let maxZ = 10;
      notesData.forEach(n => {
        const z = parseInt(n.zIndex, 10);
        if (!isNaN(z) && z > maxZ && z < 100000) {
          maxZ = z;
        }
      });
      highestZIndex = maxZ;
      renderCurrentPageNotes();
      updateFabBadge();
      updateFabButtonState();
    }
  });

  // Render all notes belonging to the current domain
  function renderCurrentPageNotes() {
    if (!canvasEl) return;
    const activePageNotes = notesData.filter(isNoteOnCurrentDomain);

    // Remove any notes no longer present
    for (const [id, element] of notesMap.entries()) {
      if (!activePageNotes.some(n => n.id === id)) {
        element.remove();
        notesMap.delete(id);
      }
    }

    // Render or update each note
    activePageNotes.forEach(note => {
      let el = notesMap.get(note.id);
      if (el) {
        updateNoteElement(el, note);
      } else {
        el = createNoteElement(note);
        notesMap.set(note.id, el);
        canvasEl.appendChild(el);
      }

      // Enforce complete hiding when note.hidden is true
      if (note.hidden) {
        el.style.display = 'none';
        el.classList.add('is-hidden');
      } else {
        el.style.display = 'flex';
        el.classList.remove('is-hidden');
      }
    });

    if (canvasEl) {
      canvasEl.style.display = currentSettings.notesVisible ? 'block' : 'none';
    }

    updateFabButtonState();
  }

  // Create Floating Action Button (FAB)
  function createFab() {
    fabEl = document.createElement('div');
    fabEl.className = 'notesticky-fab-container' + (currentSettings.fabMinimized ? ' minimized' : '');
    const shouldShow = currentSettings.showFloatingButton !== false;
    fabEl.classList.toggle('is-hidden', !shouldShow);
    fabEl.style.display = shouldShow ? 'flex' : 'none';
    fabEl.setAttribute('role', 'toolbar');
    fabEl.setAttribute('aria-label', 'NoteSticky toolbar');

    fabEl.innerHTML = `
      <div class="fab-content" style="display: ${currentSettings.fabMinimized ? 'none' : 'flex'}; align-items: center; gap: 8px;">
        <button type="button" class="fab-btn fab-btn-primary" id="fab-add-btn" title="Add Sticky Note (Alt+Shift+N)" aria-label="Create new sticky note (Alt+Shift+N)">
          <span aria-hidden="true">➕</span>
          <span>New Note</span>
        </button>
        <div class="fab-separator" aria-hidden="true"></div>
        <button type="button" class="fab-btn" id="fab-toggle-btn" title="Hide/Show Note" aria-label="Toggle notes visibility on page">
          <span id="fab-toggle-icon" aria-hidden="true">👁️</span>
        </button>
        <span class="fab-badge" id="fab-counter" role="status" aria-live="polite" aria-label="Notes on this page" title="Notes on this page (click to view/toggle notes)" tabindex="0">0</span>
        <button type="button" class="fab-btn" id="fab-collapse-btn" title="Minimize toolbar" aria-label="Minimize floating toolbar">
          <span aria-hidden="true">↘</span>
        </button>
      </div>
      <button type="button" class="fab-btn fab-mini-toggle" id="fab-mini-btn" style="display: ${currentSettings.fabMinimized ? 'flex' : 'none'}; padding: 6px;" title="Open Sticky Notes Toolbar" aria-label="Expand NoteSticky toolbar">
        <span aria-hidden="true">📌</span>
      </button>

      <!-- Optional context popover to choose specific note to toggle -->
      <div class="fab-notes-popover" id="fab-notes-popover" role="dialog" aria-modal="false" aria-label="Page notes list"></div>
    `;

    shadowRoot.appendChild(fabEl);

    // Event listeners for FAB
    const addBtn = fabEl.querySelector('#fab-add-btn');
    const toggleBtn = fabEl.querySelector('#fab-toggle-btn');
    const collapseBtn = fabEl.querySelector('#fab-collapse-btn');
    const miniBtn = fabEl.querySelector('#fab-mini-btn');

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      createNote();
    });

    // Clicking Hide/Show button toggles the specific sticky note popup (not all notes)
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFabToggleClick();
    });

    // Right-click / context menu on toggle button allows picking specific note from list
    toggleBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFabNotesPopover();
    });

    const counterBadge = fabEl.querySelector('#fab-counter');
    if (counterBadge) {
      counterBadge.style.cursor = 'pointer';
      counterBadge.title = 'Notes on this page (click to view/toggle notes)';
      counterBadge.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFabNotesPopover();
      });
      counterBadge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          toggleFabNotesPopover();
        }
      });
    }

    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFabMinimize(true);
    });

    miniBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFabMinimize(false);
    });

    // Close context popover on outside click
    document.addEventListener('pointerdown', (e) => {
      const popover = fabEl.querySelector('#fab-notes-popover');
      if (popover && popover.classList.contains('open')) {
        const path = e.composedPath();
        if (!path.includes(fabEl)) {
          popover.classList.remove('open');
        }
      }
    });

    updateFabButtonState();
  }

  // Synchronize Floating Action Button (FAB) visibility with current settings
  function updateFabVisibility() {
    if (!fabEl) return;
    const shouldShow = currentSettings.showFloatingButton !== false;
    fabEl.classList.toggle('is-hidden', !shouldShow);
    fabEl.style.display = shouldShow ? 'flex' : 'none';
    if (!shouldShow) {
      const popover = fabEl.querySelector('#fab-notes-popover');
      if (popover) popover.classList.remove('open');
    } else {
      toggleFabMinimize(!!currentSettings.fabMinimized, false);
    }
  }

  function toggleFabMinimize(minimized, save = true) {
    currentSettings.fabMinimized = !!minimized;
    if (fabEl) {
      // If floating toolbar is disabled in settings, ensure it remains hidden
      if (currentSettings.showFloatingButton === false) {
        fabEl.classList.add('is-hidden');
        fabEl.style.display = 'none';
        return;
      }
      fabEl.classList.toggle('minimized', !!minimized);
      const content = fabEl.querySelector('.fab-content');
      const miniBtn = fabEl.querySelector('#fab-mini-btn');
      if (content) content.style.display = minimized ? 'none' : 'flex';
      if (miniBtn) miniBtn.style.display = minimized ? 'flex' : 'none';
    }

    if (save) {
      chrome.storage.local.get(['settings'], (res) => {
        const settings = res.settings || {};
        settings.fabMinimized = !!minimized;
        chrome.storage.local.set({ settings });
      });
    }
  }

  function updateFabBadge() {
    if (!fabEl) return;
    const count = notesData.filter(isNoteOnCurrentDomain).length;
    const counter = fabEl.querySelector('#fab-counter');
    if (counter) {
      counter.textContent = count.toString();
      counter.style.display = count > 0 ? 'inline-block' : 'none';
    }
    // Notify background for extension icon badge
    chrome.runtime.sendMessage({ action: 'UPDATE_BADGE' }).catch(() => {});
  }

  // Handle click on the Floating Quick Toolbar Hide/Show button
  // Hides or shows all currently open popup notes on this domain simultaneously
  function handleFabToggleClick() {
    const pageNotes = notesData.filter(isNoteOnCurrentDomain);
    if (pageNotes.length === 0) return;

    if (canvasEl && canvasEl.style.display === 'none') {
      canvasEl.style.display = 'block';
    }

    // Check if any notes on this domain are currently visible
    const hasVisibleNotes = pageNotes.some(n => !n.hidden);

    // If at least one note is currently visible, hide all notes on this domain simultaneously!
    // If all notes are currently hidden, show all notes on this domain simultaneously!
    const shouldHideAll = hasVisibleNotes;

    pageNotes.forEach(note => {
      note.hidden = shouldHideAll;
      note.updatedAt = Date.now();
      const el = notesMap.get(note.id);
      if (el) {
        el.classList.toggle('is-hidden', shouldHideAll);
        el.style.display = shouldHideAll ? 'none' : 'flex';
        if (shouldHideAll) {
          el.classList.remove('is-active-note');
        }
      }
    });

    if (shouldHideAll) {
      lastActiveNoteId = null;
      hiddenNotesStack = pageNotes.map(n => n.id);
    } else {
      hiddenNotesStack = [];
      // When showing all notes, bring the topmost note to the front as active
      const topmost = [...pageNotes].sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0))[0];
      if (topmost) {
        lastActiveNoteId = topmost.id;
        const topEl = notesMap.get(topmost.id);
        if (topEl) bringToFront(topEl, topmost.id, false);
      }
    }

    currentSettings.notesVisible = !shouldHideAll;

    // Save to storage
    chrome.storage.local.get(['settings'], (res) => {
      const settings = res.settings || {};
      settings.notesVisible = currentSettings.notesVisible;
      chrome.storage.local.set({ settings, notes: notesData }, () => {
        updateFabBadge();
      });
    });

    updateFabButtonState();
  }

  // Update Hide/Show button icon & tooltip on the Floating Quick Toolbar
  function updateFabButtonState() {
    if (!fabEl) return;
    const pageNotes = notesData.filter(isNoteOnCurrentDomain);

    const toggleBtn = fabEl.querySelector('#fab-toggle-btn');
    const toggleIcon = fabEl.querySelector('#fab-toggle-icon');
    if (!toggleBtn || !toggleIcon) return;

    if (pageNotes.length === 0) {
      toggleIcon.textContent = '👁️';
      toggleBtn.title = 'No notes on this domain';
      return;
    }

    const hasVisibleNotes = pageNotes.some(n => !n.hidden);

    if (hasVisibleNotes) {
      toggleIcon.textContent = '👁️';
      toggleBtn.title = `Hide all notes on this domain (${pageNotes.length})`;
    } else {
      toggleIcon.textContent = '🙈';
      toggleBtn.title = `Show all notes on this domain (${pageNotes.length})`;
    }
  }

  // Contextmenu popover to pick specific note to show/hide
  function toggleFabNotesPopover() {
    if (!fabEl) return;
    const popover = fabEl.querySelector('#fab-notes-popover');
    if (!popover) return;

    if (popover.classList.contains('open')) {
      popover.classList.remove('open');
      return;
    }

    const pageNotes = notesData.filter(isNoteOnCurrentDomain);
    if (pageNotes.length === 0) return;

    const colors = {
      yellow: '#FEF08A',
      mint: '#BBF7D0',
      coral: '#FECDD3',
      lavender: '#E9D5FF',
      sky: '#BAE6FD',
      peach: '#FED7AA',
      slate: '#1E293B'
    };

    const itemsHtml = pageNotes.map(n => {
      const dotColor = colors[n.color] || '#FEF08A';
      const title = (n.text || 'Untitled Note').trim() || 'Untitled Note';
      return `
        <div class="fab-popover-item ${n.hidden ? 'is-note-hidden' : ''}" data-id="${n.id}" role="button" tabindex="0" aria-label="${escapeHtml(title)} - ${n.hidden ? 'Hidden, click to show' : 'Visible, click to hide'}">
          <div class="fab-popover-title-wrapper">
            <span class="fab-popover-dot" style="background: ${dotColor};" aria-hidden="true"></span>
            <span class="fab-popover-title">${escapeHtml(title)}</span>
          </div>
          <button type="button" class="fab-popover-btn" title="${n.hidden ? 'Show this note' : 'Hide this note'}" aria-label="${n.hidden ? 'Show this note' : 'Hide this note'}">
            <span aria-hidden="true">${n.hidden ? '🙈' : '👁️'}</span>
          </button>
        </div>
      `;
    }).join('');

    popover.innerHTML = `
      <div class="fab-popover-header">Page Notes (${pageNotes.length})</div>
      <div style="max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;" role="list">
        ${itemsHtml}
      </div>
    `;

    popover.querySelectorAll('.fab-popover-item').forEach(item => {
      const noteId = item.dataset.id;
      const activateItem = (e) => {
        e.stopPropagation();
        const note = notesData.find(n => n.id === noteId);
        if (note) {
          setNoteHidden(noteId, !note.hidden);
          if (!note.hidden) {
            const el = notesMap.get(noteId);
            if (el) bringToFront(el, noteId);
          }
          popover.classList.remove('open');
        }
      };
      item.addEventListener('click', activateItem);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activateItem(e);
        }
      });
    });

    popover.classList.add('open');
  }

  // Toggle Visibility of All Notes on Current Page (from extension shortcut or settings)
  function toggleVisibility() {
    handleFabToggleClick();
  }

  // Set independent hide/show state for a single sticky note
  function setNoteHidden(id, isHidden) {
    const current = notesData.find(n => n.id === id);
    if (!current) return;

    current.hidden = !!isHidden;
    current.updatedAt = Date.now();

    const el = notesMap.get(id);
    if (el) {
      el.classList.toggle('is-hidden', current.hidden);
      el.style.display = current.hidden ? 'none' : 'flex';
      if (current.hidden) {
        el.classList.remove('is-active-note');
      }
    }

    if (isHidden) {
      lastHiddenNoteId = id;
      hiddenNotesStack = hiddenNotesStack.filter(x => x !== id);
      hiddenNotesStack.push(id);
      lastActiveNoteId = null;
    } else {
      if (lastHiddenNoteId === id) {
        lastHiddenNoteId = null;
      }
      hiddenNotesStack = hiddenNotesStack.filter(x => x !== id);
      lastActiveNoteId = id;
      if (el) {
        bringToFront(el, id, false);
      }
    }

    updateFabButtonState();
    saveNotesToStorage();
  }

  // Create a new note object & DOM element
  function createNote(initialText = '', x = null, y = null) {
    const isFixed = currentSettings.pinMode === 'screen';
    const noteId = 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    // Calculate smart initial positioning
    let initialX = x;
    let initialY = y;
    if (initialX === null || initialY === null) {
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
      const existingCount = notesMap.size;
      const offset = (existingCount * 25) % 150;

      if (isFixed) {
        initialX = Math.max(20, Math.min(window.innerWidth - 280, 80 + offset));
        initialY = Math.max(20, Math.min(window.innerHeight - 260, 100 + offset));
      } else {
        initialX = scrollX + Math.max(20, Math.min(window.innerWidth - 280, 80 + offset));
        initialY = scrollY + Math.max(20, Math.min(window.innerHeight - 260, 100 + offset));
      }
    }

    const newNote = {
      id: noteId,
      text: initialText,
      url: getCurrentUrl(),
      domain: getCurrentDomain(),
      pageTitle: getPageTitle(),
      color: currentSettings.defaultColor || 'yellow',
      x: initialX,
      y: initialY,
      width: 250,
      height: 220,
      pinned: isFixed,
      minimized: false,
      zIndex: ++highestZIndex,
      isChecklist: false,
      checklistItems: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    notesData.push(newNote);
    saveNotesToStorage();

    const noteEl = createNoteElement(newNote);
    notesMap.set(newNote.id, noteEl);
    canvasEl.appendChild(noteEl);
    bringToFront(noteEl, newNote.id);
    updateFabBadge();
    updateFabButtonState();

    // Auto-focus input
    setTimeout(() => {
      const body = noteEl.querySelector('.note-body');
      if (body) body.focus();
    }, 50);

    return newNote;
  }

  // Create DOM Element for Note
  function createNoteElement(note) {
    const noteEl = document.createElement('div');
    noteEl.className = `sticky-note theme-${note.color} ${note.pinned ? 'fixed-mode' : ''} ${note.minimized ? 'minimized' : ''} ${note.hidden ? 'is-hidden' : ''}`;
    noteEl.id = `sticky-note-${note.id}`;
    noteEl.dataset.id = note.id;
    noteEl.style.left = `${note.x}px`;
    noteEl.style.top = `${note.y}px`;
    noteEl.style.width = `${note.width}px`;
    noteEl.style.height = `${note.height}px`;
    noteEl.style.zIndex = note.zIndex || highestZIndex;
    noteEl.style.display = note.hidden ? 'none' : 'flex';

    const colors = [
      { id: 'yellow', hex: '#FEF08A' },
      { id: 'mint', hex: '#BBF7D0' },
      { id: 'coral', hex: '#FECDD3' },
      { id: 'lavender', hex: '#E9D5FF' },
      { id: 'sky', hex: '#BAE6FD' },
      { id: 'peach', hex: '#FED7AA' },
      { id: 'slate', hex: '#1E293B' }
    ];

    const paletteHtml = colors.map(c => `
      <button type="button" class="color-dot ${c.id === note.color ? 'active' : ''}" data-color="${c.id}" style="background: ${c.hex};" title="${c.id}" aria-label="Set color to ${c.id}" aria-pressed="${c.id === note.color}"></button>
    `).join('');

    noteEl.setAttribute('role', 'region');
    const fullTitle = (note.text || (note.checklistItems && note.checklistItems[0] ? note.checklistItems[0].text : 'Note')).trim();
    noteEl.setAttribute('aria-label', `Sticky Note: ${(fullTitle || 'Untitled').slice(0, 30)}`);

    noteEl.innerHTML = `
      <div class="note-header">
        <div class="note-header-left">
          <button type="button" class="pin-indicator ${note.pinned ? 'pinned' : ''}" title="${note.pinned ? 'Pinned to screen (click to scroll with page)' : 'Scrolls with page (click to pin to screen)'}" aria-label="${note.pinned ? 'Unpin note (currently pinned to screen)' : 'Pin note to screen'}" aria-pressed="${!!note.pinned}">
            ${note.pinned ? '📌' : '📍'}
          </button>
          <span class="note-title-preview" title="${escapeHtml(fullTitle || 'Note')}">
            ${escapeHtml(fullTitle || 'Note')}
          </span>
        </div>
        <div class="note-header-actions" role="toolbar" aria-label="Note actions">
          <button type="button" class="icon-btn" id="btn-edit" title="Edit Note" aria-label="Edit note content">✏️</button>
          <button type="button" class="icon-btn" id="btn-palette" title="Change Color (Right-click to quick cycle)" aria-label="Change note color">🎨</button>
          <button type="button" class="icon-btn" id="btn-checklist" title="${note.isChecklist ? 'Switch to Note' : 'Switch to Checklist'}" aria-label="${note.isChecklist ? 'Switch to plain text note' : 'Switch to checklist'}">
            ${note.isChecklist ? '📝' : '☑️'}
          </button>
          <button type="button" class="icon-btn" id="btn-toggle-vis" title="Hide this note" aria-label="Hide note from page">👁️</button>
          <button type="button" class="icon-btn" id="btn-minimize" title="${note.minimized ? 'Expand' : 'Minimize'}" aria-label="${note.minimized ? 'Expand note' : 'Minimize note'}">
            ${note.minimized ? '🗖' : '🗕'}
          </button>
          <button type="button" class="icon-btn danger" id="btn-delete" title="Delete Note" aria-label="Delete note">✕</button>
        </div>
      </div>

      <!-- Color Palette Popover -->
      <div class="palette-popover" role="toolbar" aria-label="Color options">
        ${paletteHtml}
      </div>

      <!-- Body / Checklist Container -->
      <div class="note-body-wrapper" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        ${renderNoteBodyContent(note)}
      </div>

      <!-- Footer -->
      <div class="note-footer">
        <span class="footer-time">${formatTimeAgo(note.updatedAt || note.createdAt)}</span>
        <span class="footer-status" style="opacity: 0.8;" aria-live="polite"></span>
      </div>

      <!-- Resize Grip -->
      <div class="resize-handle" title="Resize" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M9 1 L1 9 M9 5 L5 9 M9 9 L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
    `;

    // Setup Event Listeners
    setupNoteEvents(noteEl, note);

    return noteEl;
  }

  // Update existing DOM Element
  function updateNoteElement(noteEl, note) {
    // ALWAYS update theme class, even if currently focused/editing!
    const allThemes = ['yellow', 'mint', 'coral', 'lavender', 'sky', 'peach', 'slate'];
    allThemes.forEach(t => noteEl.classList.remove(`theme-${t}`));
    noteEl.classList.add(`theme-${note.color || 'yellow'}`);

    noteEl.setAttribute('aria-label', `Sticky Note: ${(note.text || 'Untitled').trim().slice(0, 30) || 'Untitled'}`);

    // Update active dot in palette
    const palettePopover = noteEl.querySelector('.palette-popover');
    if (palettePopover) {
      palettePopover.querySelectorAll('.color-dot').forEach(dot => {
        const isActive = dot.dataset.color === (note.color || 'yellow');
        dot.classList.toggle('active', isActive);
        dot.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    const visBtn = noteEl.querySelector('#btn-toggle-vis');
    if (visBtn) {
      visBtn.title = "Hide this note";
      visBtn.setAttribute('aria-label', 'Hide note from page');
      visBtn.textContent = '👁️';
    }

    noteEl.classList.toggle('is-hidden', !!note.hidden);
    noteEl.style.display = note.hidden ? 'none' : 'flex';
    if (note.hidden) {
      noteEl.classList.remove('is-active-note');
    }

    // Only update body/position if not currently active/being edited to avoid cursor jumping
    const activeEl = shadowRoot.activeElement;
    const isCurrentlyEditing = noteEl.contains(activeEl);

    if (!isCurrentlyEditing) {
      noteEl.classList.toggle('fixed-mode', !!note.pinned);
      noteEl.classList.toggle('minimized', !!note.minimized);
      noteEl.style.left = `${note.x}px`;
      noteEl.style.top = `${note.y}px`;
      noteEl.style.width = `${note.width}px`;
      noteEl.style.height = `${note.height}px`;
      noteEl.style.zIndex = note.zIndex || highestZIndex;

      const bodyWrapper = noteEl.querySelector('.note-body-wrapper');
      if (bodyWrapper) {
        bodyWrapper.innerHTML = renderNoteBodyContent(note);
        setupBodyEvents(noteEl, note);
      }

      const timeEl = noteEl.querySelector('.footer-time');
      if (timeEl) timeEl.textContent = formatTimeAgo(note.updatedAt || note.createdAt);

      const pinEl = noteEl.querySelector('.pin-indicator');
      if (pinEl) {
        pinEl.className = `pin-indicator ${note.pinned ? 'pinned' : ''}`;
        pinEl.textContent = note.pinned ? '📌' : '📍';
        pinEl.title = note.pinned ? 'Pinned to screen (click to scroll with page)' : 'Scrolls with page (click to pin to screen)';
        pinEl.setAttribute('aria-label', note.pinned ? 'Unpin note (currently pinned to screen)' : 'Pin note to screen');
        pinEl.setAttribute('aria-pressed', note.pinned ? 'true' : 'false');
      }

      const minimizeBtn = noteEl.querySelector('#btn-minimize');
      if (minimizeBtn) {
        minimizeBtn.textContent = note.minimized ? '🗖' : '🗕';
        minimizeBtn.title = note.minimized ? 'Expand' : 'Minimize';
        minimizeBtn.setAttribute('aria-label', note.minimized ? 'Expand note' : 'Minimize note');
      }

      const preview = noteEl.querySelector('.note-title-preview');
      if (preview) {
        const fullTitle = (note.text || (note.checklistItems && note.checklistItems[0] ? note.checklistItems[0].text : 'Note')).trim();
        preview.textContent = fullTitle || 'Note';
        preview.title = fullTitle || 'Note';
      }

      const checklistBtn = noteEl.querySelector('#btn-checklist');
      if (checklistBtn) {
        checklistBtn.textContent = note.isChecklist ? '📝' : '☑️';
        checklistBtn.title = note.isChecklist ? 'Switch to Note' : 'Switch to Checklist';
        checklistBtn.setAttribute('aria-label', note.isChecklist ? 'Switch to plain text note' : 'Switch to checklist');
      }
    }
  }

  // Render note body (rich text vs checklist)
  function renderNoteBodyContent(note) {
    if (note.isChecklist) {
      const items = note.checklistItems || [];
      const itemsHtml = items.map((item, idx) => `
        <div class="checklist-item ${item.done ? 'done' : ''}" data-item-id="${item.id}">
          <input type="checkbox" ${item.done ? 'checked' : ''} aria-label="Mark item completed" />
          <input type="text" class="checklist-item-text" value="${escapeHtml(item.text)}" placeholder="To do item..." aria-label="Checklist item text" />
          <button type="button" class="checklist-item-delete" title="Remove item" aria-label="Remove item">✕</button>
        </div>
      `).join('');

      return `
        <div class="note-body checklist-container" style="overflow-y: auto;" role="region" aria-label="Checklist">
          <div class="checklist-items">${itemsHtml}</div>
          <button type="button" class="checklist-add-btn" aria-label="Add new checklist item">
            <span aria-hidden="true">+</span> Add item
          </button>
        </div>
      `;
    } else {
      return `
        <div class="note-body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Sticky note content" data-placeholder="Type your sticky note here...">${escapeHtml(note.text || '')}</div>
      `;
    }
  }

  // Setup interactions for note element
  function setupNoteEvents(noteEl, note) {
    const id = note.id;

    // Bring note to top immediately on interaction (single capture listener to prevent handler spam)
    const activateNote = () => {
      bringToFront(noteEl, id);
    };

    noteEl.addEventListener('pointerdown', activateNote, true);

    // Header actions
    const header = noteEl.querySelector('.note-header');
    const pinBtn = noteEl.querySelector('.pin-indicator');
    const editBtn = noteEl.querySelector('#btn-edit');
    const paletteBtn = noteEl.querySelector('#btn-palette');
    const checklistBtn = noteEl.querySelector('#btn-checklist');
    const toggleVisBtn = noteEl.querySelector('#btn-toggle-vis');
    const minimizeBtn = noteEl.querySelector('#btn-minimize');
    const deleteBtn = noteEl.querySelector('#btn-delete');
    const palettePopover = noteEl.querySelector('.palette-popover');
    const resizeHandle = noteEl.querySelector('.resize-handle');

    // Edit button click - activates and focuses the note for editing
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const current = notesData.find(n => n.id === id);
        if (current && current.minimized) {
          current.minimized = false;
          noteEl.classList.remove('minimized');
          if (minimizeBtn) {
            minimizeBtn.textContent = '🗕';
            minimizeBtn.title = 'Minimize';
            minimizeBtn.setAttribute('aria-label', 'Minimize note');
          }
          saveNotesDebounced(id);
        }
        bringToFront(noteEl, id);
        const body = noteEl.querySelector('.note-body');
        if (body) {
          if (body.classList.contains('checklist-container')) {
            const firstInput = body.querySelector('.checklist-item-text');
            if (firstInput) {
              firstInput.focus();
            } else {
              const addBtn = body.querySelector('.checklist-add-btn');
              if (addBtn) addBtn.focus();
            }
          } else {
            body.focus();
            if (typeof window.getSelection !== 'undefined' && typeof document.createRange !== 'undefined') {
              const range = document.createRange();
              range.selectNodeContents(body);
              range.collapse(false);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        }
      });
    }

    // Dragging logic
    setupDragging(noteEl, header, id);

    // Resizing logic
    setupResizing(noteEl, resizeHandle, id);

    // Pinning toggle
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = notesData.find(n => n.id === id);
      if (!current) return;

      current.pinned = !current.pinned;
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft;

      if (current.pinned) {
        // Convert page coordinates to viewport fixed coordinates
        current.x = Math.max(0, current.x - scrollX);
        current.y = Math.max(0, current.y - scrollY);
      } else {
        // Convert viewport coordinates to page coordinates
        current.x = current.x + scrollX;
        current.y = current.y + scrollY;
      }

      noteEl.classList.toggle('fixed-mode', current.pinned);
      noteEl.style.left = `${current.x}px`;
      noteEl.style.top = `${current.y}px`;
      pinBtn.classList.toggle('pinned', current.pinned);
      pinBtn.textContent = current.pinned ? '📌' : '📍';
      pinBtn.title = current.pinned ? 'Pinned to screen (click to scroll with page)' : 'Scrolls with page (click to pin to screen)';
      pinBtn.setAttribute('aria-label', current.pinned ? 'Unpin note (currently pinned to screen)' : 'Pin note to screen');
      pinBtn.setAttribute('aria-pressed', current.pinned ? 'true' : 'false');

      saveNotesDebounced(id);
    });

    // Palette interactions
    paletteBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    paletteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      palettePopover.classList.toggle('open');
    });

    // Right-click on palette button cycles colors as a quick shortcut
    paletteBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cycleNextColor();
    });

    palettePopover.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });

    function selectColor(newColor) {
      if (!newColor) return;
      const current = notesData.find(n => n.id === id);
      if (current) {
        current.color = newColor;
        current.updatedAt = Date.now();
      }

      const allThemes = ['yellow', 'mint', 'coral', 'lavender', 'sky', 'peach', 'slate'];
      allThemes.forEach(t => noteEl.classList.remove(`theme-${t}`));
      noteEl.classList.add(`theme-${newColor}`);

      palettePopover.querySelectorAll('.color-dot').forEach(dot => {
        const isActive = dot.dataset.color === newColor;
        dot.classList.toggle('active', isActive);
        dot.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      palettePopover.classList.remove('open');
      saveNotesToStorage();
    }

    function cycleNextColor() {
      const allThemes = ['yellow', 'mint', 'coral', 'lavender', 'sky', 'peach', 'slate'];
      const current = notesData.find(n => n.id === id);
      const currColor = (current && current.color) || 'yellow';
      const nextIdx = (allThemes.indexOf(currColor) + 1) % allThemes.length;
      selectColor(allThemes[nextIdx]);
    }

    palettePopover.addEventListener('click', (e) => {
      e.stopPropagation();
      const dot = e.target.closest('.color-dot');
      if (dot && dot.dataset.color) {
        selectColor(dot.dataset.color);
      }
    });

    // Note: click-outside palette dismissal is handled cleanly by the delegated listener in initContainer

    // Checklist mode switch
    checklistBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = notesData.find(n => n.id === id);
      if (!current) return;

      current.isChecklist = !current.isChecklist;
      if (current.isChecklist) {
        // Bi-directional conversion: parse lines of text to checklist items preserving [x] and [ ] tags
        const lines = (current.text || '').split('\n').map(l => l.trim()).filter(Boolean);
        current.checklistItems = lines.length ? lines.map(line => {
          let isDone = false;
          let text = line;
          if (/^\[x\]\s*/i.test(line)) {
            isDone = true;
            text = line.replace(/^\[x\]\s*/i, '');
          } else if (/^\[\s*\]\s*/i.test(line)) {
            isDone = false;
            text = line.replace(/^\[\s*\]\s*/i, '');
          }
          return {
            id: 'item_' + Math.random().toString(36).substring(2, 6),
            text: text,
            done: isDone
          };
        }) : [{
          id: 'item_' + Math.random().toString(36).substring(2, 6),
          text: '',
          done: false
        }];
      } else {
        // Bi-directional conversion: format checklist items back to clean text
        current.text = (current.checklistItems || []).map(i => (i.done ? '[x] ' : '[ ] ') + (i.text || '')).join('\n');
      }

      current.updatedAt = Date.now();
      checklistBtn.textContent = current.isChecklist ? '📝' : '☑️';
      checklistBtn.title = current.isChecklist ? 'Switch to Note' : 'Switch to Checklist';
      checklistBtn.setAttribute('aria-label', current.isChecklist ? 'Switch to plain text note' : 'Switch to checklist');

      const bodyWrapper = noteEl.querySelector('.note-body-wrapper');
      bodyWrapper.innerHTML = renderNoteBodyContent(current);
      setupBodyEvents(noteEl, current);
      saveNotesDebounced(id);
    });

    // Independent Hide on this specific note
    if (toggleVisBtn) {
      const handleHideClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setNoteHidden(id, true);
      };

      toggleVisBtn.addEventListener('click', handleHideClick);
      toggleVisBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
    }

    // Minimize toggle
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = notesData.find(n => n.id === id);
      if (!current) return;

      current.minimized = !current.minimized;
      noteEl.classList.toggle('minimized', current.minimized);
      minimizeBtn.textContent = current.minimized ? '🗖' : '🗕';
      minimizeBtn.title = current.minimized ? 'Expand' : 'Minimize';
      minimizeBtn.setAttribute('aria-label', current.minimized ? 'Expand note' : 'Minimize note');

      const preview = noteEl.querySelector('.note-title-preview');
      if (preview) {
        const previewText = (current.text || (current.checklistItems && current.checklistItems[0] ? current.checklistItems[0].text : 'Note')).trim();
        preview.textContent = previewText || 'Note';
        preview.title = previewText || 'Note';
      }

      saveNotesDebounced(id);
    });

    // Delete note
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNoteWithUndo(id);
    });

    // Setup body events (text editing or checklist items)
    setupBodyEvents(noteEl, note);
  }

  // Setup body events for text & checklist
  function setupBodyEvents(noteEl, note) {
    const id = note.id;
    const body = noteEl.querySelector('.note-body');
    if (!body) return;

    if (!note.isChecklist) {
      // Contenteditable plain/rich text
      body.addEventListener('input', () => {
        const current = notesData.find(n => n.id === id);
        if (!current) return;

        current.text = body.innerText;
        current.updatedAt = Date.now();
        const previewText = current.text.trim();
        noteEl.setAttribute('aria-label', `Sticky Note: ${(previewText || 'Untitled').slice(0, 30)}`);
        const preview = noteEl.querySelector('.note-title-preview');
        if (preview) {
          preview.textContent = previewText || 'Note';
          preview.title = previewText || 'Note';
        }
        showStatus(noteEl, 'Saving...');
        saveNotesDebounced(id);
      });

      // Keyboard shortcuts inside note
      body.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          document.execCommand('bold');
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
          e.preventDefault();
          document.execCommand('italic');
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') {
          e.preventDefault();
          document.execCommand('underline');
        }
      });
    } else {
      // Checklist items listeners
      const container = noteEl.querySelector('.checklist-items');
      const addBtn = noteEl.querySelector('.checklist-add-btn');

      // Checkbox click
      container.addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') {
          const itemEl = e.target.closest('.checklist-item');
          const itemId = itemEl.dataset.itemId;
          const current = notesData.find(n => n.id === id);
          if (!current || !current.checklistItems) return;

          const item = current.checklistItems.find(i => i.id === itemId);
          if (item) {
            item.done = e.target.checked;
            itemEl.classList.toggle('done', item.done);
            current.updatedAt = Date.now();
            saveNotesDebounced(id);
          }
        }
      });

      // Item text typing
      container.addEventListener('input', (e) => {
        if (e.target.classList.contains('checklist-item-text')) {
          const itemEl = e.target.closest('.checklist-item');
          const itemId = itemEl.dataset.itemId;
          const current = notesData.find(n => n.id === id);
          if (!current || !current.checklistItems) return;

          const item = current.checklistItems.find(i => i.id === itemId);
          if (item) {
            item.text = e.target.value;
            current.updatedAt = Date.now();
            saveNotesDebounced(id);
          }
        }
      });

      // Keyboard interactions for checklist items (Enter, Backspace, ArrowUp, ArrowDown)
      container.addEventListener('keydown', (e) => {
        if (!e.target.classList.contains('checklist-item-text')) return;

        const currentInput = e.target;
        const currentItemEl = currentInput.closest('.checklist-item');
        if (!currentItemEl) return;
        const currentItemId = currentItemEl.dataset.itemId;
        const current = notesData.find(n => n.id === id);
        if (!current || !current.checklistItems) return;

        // 1. Enter key: inserts a new item immediately after current item
        if (e.key === 'Enter') {
          e.preventDefault();
          addNewChecklistItem(noteEl, id, currentItemId);
          return;
        }

        // 2. Backspace key on empty input: deletes current item and focuses previous
        if (e.key === 'Backspace' && currentInput.value === '') {
          const allItems = Array.from(container.querySelectorAll('.checklist-item'));
          if (allItems.length > 1) {
            e.preventDefault();
            const currIdx = allItems.indexOf(currentItemEl);
            const targetItemEl = allItems[currIdx - 1] || allItems[currIdx + 1];

            // Remove from data model
            current.checklistItems = current.checklistItems.filter(i => i.id !== currentItemId);
            current.updatedAt = Date.now();
            currentItemEl.remove();
            saveNotesDebounced(id);

            // Focus target input
            if (targetItemEl) {
              const targetInput = targetItemEl.querySelector('.checklist-item-text');
              if (targetInput) {
                targetInput.focus();
                const len = targetInput.value.length;
                targetInput.setSelectionRange(len, len);
              }
            }
          }
          return;
        }

        // 3. ArrowUp: navigate to previous item
        if (e.key === 'ArrowUp') {
          const allItems = Array.from(container.querySelectorAll('.checklist-item'));
          const currIdx = allItems.indexOf(currentItemEl);
          if (currIdx > 0) {
            e.preventDefault();
            const prevInput = allItems[currIdx - 1].querySelector('.checklist-item-text');
            if (prevInput) {
              prevInput.focus();
              const len = prevInput.value.length;
              prevInput.setSelectionRange(len, len);
            }
          }
          return;
        }

        // 4. ArrowDown: navigate to next item
        if (e.key === 'ArrowDown') {
          const allItems = Array.from(container.querySelectorAll('.checklist-item'));
          const currIdx = allItems.indexOf(currentItemEl);
          if (currIdx < allItems.length - 1) {
            e.preventDefault();
            const nextInput = allItems[currIdx + 1].querySelector('.checklist-item-text');
            if (nextInput) {
              nextInput.focus();
              const len = nextInput.value.length;
              nextInput.setSelectionRange(len, len);
            }
          }
          return;
        }
      });

      // Item delete button
      container.addEventListener('click', (e) => {
        const delBtn = e.target.closest('.checklist-item-delete');
        if (delBtn) {
          const itemEl = delBtn.closest('.checklist-item');
          const itemId = itemEl.dataset.itemId;
          const current = notesData.find(n => n.id === id);
          if (!current || !current.checklistItems) return;

          current.checklistItems = current.checklistItems.filter(i => i.id !== itemId);
          current.updatedAt = Date.now();
          itemEl.remove();
          saveNotesDebounced(id);
        }
      });

      // Add item button
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          addNewChecklistItem(noteEl, id);
        });
      }
    }
  }

  function addNewChecklistItem(noteEl, noteId, afterItemId = null) {
    const current = notesData.find(n => n.id === noteId);
    if (!current) return;
    if (!current.checklistItems) current.checklistItems = [];

    const newItem = {
      id: 'item_' + Math.random().toString(36).substring(2, 6),
      text: '',
      done: false
    };

    const container = noteEl.querySelector('.checklist-items');
    const itemEl = document.createElement('div');
    itemEl.className = 'checklist-item';
    itemEl.dataset.itemId = newItem.id;
    itemEl.innerHTML = `
      <input type="checkbox" aria-label="Mark item completed" />
      <input type="text" class="checklist-item-text" value="" placeholder="To do item..." aria-label="Checklist item text" />
      <button type="button" class="checklist-item-delete" title="Remove item" aria-label="Remove item">✕</button>
    `;

    if (afterItemId) {
      const idx = current.checklistItems.findIndex(i => i.id === afterItemId);
      if (idx !== -1) {
        current.checklistItems.splice(idx + 1, 0, newItem);
        const refEl = container.querySelector(`[data-item-id="${afterItemId}"]`);
        if (refEl && refEl.nextSibling) {
          container.insertBefore(itemEl, refEl.nextSibling);
        } else {
          container.appendChild(itemEl);
        }
      } else {
        current.checklistItems.push(newItem);
        container.appendChild(itemEl);
      }
    } else {
      current.checklistItems.push(newItem);
      container.appendChild(itemEl);
    }

    const input = itemEl.querySelector('.checklist-item-text');
    if (input) input.focus();
    saveNotesDebounced(noteId);
  }

  // Smooth Dragging with Pointer Events
  function setupDragging(noteEl, handle, id) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      // Don't drag if clicking buttons
      if (e.target.closest('.icon-btn') || e.target.closest('.pin-indicator') || e.target.closest('.palette-popover')) {
        return;
      }

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseFloat(noteEl.style.left) || 0;
      origTop = parseFloat(noteEl.style.top) || 0;

      noteEl.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
      bringToFront(noteEl, id);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newX = origLeft + dx;
      let newY = origTop + dy;

      const noteWidth = noteEl.offsetWidth || 250;
      const current = notesData.find(n => n.id === id);
      const isFixed = current && current.pinned;

      // Keep within bounds to prevent horizontal scrollbar or disappearing off screen
      const docWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const maxX = Math.max(10, docWidth - noteWidth - 10);
      newX = Math.max(10, Math.min(newX, maxX));

      if (isFixed) {
        const maxY = Math.max(10, window.innerHeight - 50);
        newY = Math.max(10, Math.min(newY, maxY));
      } else {
        newY = Math.max(10, newY);
      }

      noteEl.style.left = `${newX}px`;
      noteEl.style.top = `${newY}px`;
    });

    const stopDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      noteEl.classList.remove('dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}

      const current = notesData.find(n => n.id === id);
      if (current) {
        current.x = parseFloat(noteEl.style.left);
        current.y = parseFloat(noteEl.style.top);
        current.updatedAt = Date.now();
        saveNotesDebounced(id);
      }
    };

    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);
  }

  // Smooth Resizing with Pointer Events
  function setupResizing(noteEl, handle, id) {
    let isResizing = false;
    let startX = 0;
    let startY = 0;
    let origWidth = 0;
    let origHeight = 0;

    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      origWidth = noteEl.offsetWidth;
      origHeight = noteEl.offsetHeight;

      handle.setPointerCapture(e.pointerId);
      bringToFront(noteEl, id);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const currentLeft = parseFloat(noteEl.style.left) || 0;
      const docWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const maxAllowedWidth = Math.max(200, docWidth - currentLeft - 10);

      const newWidth = Math.min(maxAllowedWidth, Math.max(200, origWidth + dx));
      const newHeight = Math.max(160, origHeight + dy);

      noteEl.style.width = `${newWidth}px`;
      noteEl.style.height = `${newHeight}px`;
    });

    const stopResize = (e) => {
      if (!isResizing) return;
      isResizing = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}

      const current = notesData.find(n => n.id === id);
      if (current) {
        current.width = noteEl.offsetWidth;
        current.height = noteEl.offsetHeight;
        current.updatedAt = Date.now();
        saveNotesDebounced(id);
      }
    };

    handle.addEventListener('pointerup', stopResize);
    handle.addEventListener('pointercancel', stopResize);
  }

  // Bring Note to Front (highest zIndex & active state)
  function bringToFront(noteEl, id) {
    lastActiveNoteId = id;

    // 1. Calculate max z-index across all rendered note elements & stored notes
    let maxZ = 10;
    notesMap.forEach((el) => {
      el.classList.remove('is-active-note');
      const z = parseInt(el.style.zIndex, 10);
      if (!isNaN(z) && z > maxZ && z < 100000) {
        maxZ = z;
      }
    });
    notesData.forEach((n) => {
      const z = parseInt(n.zIndex, 10);
      if (!isNaN(z) && z > maxZ && z < 100000) {
        maxZ = z;
      }
    });

    highestZIndex = maxZ + 2;
    if (highestZIndex > 10000) {
      normalizeZIndices();
      highestZIndex = Math.max(highestZIndex, 10) + 2;
    }

    noteEl.style.zIndex = highestZIndex;
    noteEl.classList.add('is-active-note');

    // 2. Update the data model without re-parenting DOM nodes (which would cancel caret focus and text selection)
    const current = notesData.find(n => n.id === id);
    if (current) {
      current.zIndex = highestZIndex;
      saveNotesDebounced(id);
    }

    updateFabButtonState();
  }

  // Delete note with undo toast
  function deleteNoteWithUndo(id) {
    const idx = notesData.findIndex(n => n.id === id);
    if (idx === -1) return;

    lastDeletedNote = JSON.parse(JSON.stringify(notesData[idx]));
    notesData.splice(idx, 1);

    const el = notesMap.get(id);
    if (el) {
      el.remove();
      notesMap.delete(id);
    }

    saveNotesToStorage();
    updateFabBadge();
    showUndoToast();
  }

  // Show Undo Toast
  function showUndoToast() {
    if (undoToastTimeout) clearTimeout(undoToastTimeout);

    let existingToast = shadowRoot.querySelector('.notesticky-toast');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'notesticky-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
      <span>Note deleted</span>
      <button type="button" id="toast-undo-btn" aria-label="Undo note deletion">Undo</button>
    `;
    shadowRoot.appendChild(toast);

    toast.querySelector('#toast-undo-btn').addEventListener('click', () => {
      if (lastDeletedNote) {
        notesData.push(lastDeletedNote);
        const el = createNoteElement(lastDeletedNote);
        notesMap.set(lastDeletedNote.id, el);
        canvasEl.appendChild(el);
        saveNotesToStorage();
        updateFabBadge();
        lastDeletedNote = null;
      }
      toast.remove();
    });

    undoToastTimeout = setTimeout(() => {
      if (toast) toast.remove();
      lastDeletedNote = null;
    }, 4500);
  }

  // Status helper (e.g. "Saved")
  function showStatus(noteEl, text) {
    const statusEl = noteEl.querySelector('.footer-status');
    if (statusEl) {
      statusEl.textContent = text;
      if (text === 'Saved') {
        setTimeout(() => {
          if (statusEl.textContent === 'Saved') statusEl.textContent = '';
        }, 1500);
      }
    }
  }

  // Debounced save
  function saveNotesDebounced(noteId) {
    if (saveTimeouts.has(noteId)) {
      clearTimeout(saveTimeouts.get(noteId));
    }
    const timer = setTimeout(() => {
      saveNotesToStorage();
      const el = notesMap.get(noteId);
      if (el) showStatus(el, 'Saved');
      saveTimeouts.delete(noteId);
    }, 350);
    saveTimeouts.set(noteId, timer);
  }

  function saveNotesToStorage() {
    chrome.storage.local.set({ notes: notesData }, () => {
      updateFabBadge();
    });
  }

  // Flush all pending debounced saves immediately on page unload or visibility change
  function flushAllPendingSaves() {
    if (saveTimeouts.size > 0) {
      saveTimeouts.forEach((timer) => clearTimeout(timer));
      saveTimeouts.clear();
      try {
        chrome.storage.local.set({ notes: notesData });
      } catch (_) {}
    }
  }

  window.addEventListener('pagehide', flushAllPendingSaves);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAllPendingSaves();
    }
  });

  // Format relative time
  function formatTimeAgo(ts) {
    if (!ts) return 'Just now';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Message Handler for commands from background/popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'CREATE_NOTE') {
      createNote(request.text || '', request.x || null, request.y || null);
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'TOGGLE_VISIBILITY') {
      toggleVisibility();
      sendResponse({ success: true, visible: currentSettings.notesVisible });
      return true;
    }

    if (request.action === 'UPDATE_SETTINGS' || request.action === 'SETTINGS_CHANGED') {
      if (request.settings) {
        currentSettings = { ...currentSettings, ...request.settings };
      }
      updateFabVisibility();
      if (canvasEl) {
        canvasEl.style.display = currentSettings.notesVisible ? 'block' : 'none';
      }
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'HIGHLIGHT_NOTE') {
      const { noteId } = request;
      const noteEl = notesMap.get(noteId);
      if (noteEl) {
        // Ensure canvas container is visible if previously toggled hidden
        if (canvasEl && canvasEl.style.display === 'none') {
          canvasEl.style.display = 'block';
          currentSettings.notesVisible = true;
        }

        // Unhide if hidden
        setNoteHidden(noteId, false);

        // Expand if minimized
        if (noteEl.classList.contains('minimized')) {
          noteEl.classList.remove('minimized');
          const current = notesData.find(n => n.id === noteId);
          if (current) current.minimized = false;
          const minBtn = noteEl.querySelector('#btn-minimize');
          if (minBtn) {
            minBtn.textContent = '🗕';
            minBtn.title = 'Minimize';
            minBtn.setAttribute('aria-label', 'Minimize note');
          }
        }

        // Scroll into view if not fixed
        if (!noteEl.classList.contains('fixed-mode')) {
          noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        bringToFront(noteEl, noteId);
        noteEl.classList.add('highlight-target');
        setTimeout(() => {
          noteEl.classList.remove('highlight-target');
        }, 3600);
      }
      sendResponse({ success: !!noteEl });
      return true;
    }
  });

  // Start initialization when document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initContainer);
  } else {
    initContainer();
  }
})();
