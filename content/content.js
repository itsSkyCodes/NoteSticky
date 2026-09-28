// NoteSticky - Content Script (Encapsulated in Shadow DOM)

(() => {
  // Prevent duplicate injection
  if (window.__notesticky_injected__) return;
  window.__notesticky_injected__ = true;

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
  let highestZIndex = 2147483640;
  let lastHiddenNoteId = null;
  let lastActiveNoteId = null;
  let hiddenNotesStack = [];
  let saveTimeouts = new Map();
  let lastDeletedNote = null;
  let undoToastTimeout = null;

  const getCurrentUrl = () => window.location.href.split('#')[0];
  const getCurrentDomain = () => window.location.hostname;
  const getPageTitle = () => document.title || window.location.hostname;

  // Initialize Shadow DOM Container
  function initContainer() {
    let host = document.getElementById('notesticky-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'notesticky-root';
      (document.body || document.documentElement).appendChild(host);
    }

    shadowRoot = host.attachShadow({ mode: 'open' });

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

      // Calculate initial highestZIndex from storage
      notesData.forEach(n => {
        const z = parseInt(n.zIndex, 10);
        if (!isNaN(z) && z > highestZIndex) {
          highestZIndex = z;
        }
      });

      renderCurrentPageNotes();
      updateFabBadge();
      updateFabButtonState();
    });
  }

  // Listen for storage changes from other tabs or popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.settings) {
      currentSettings = { ...currentSettings, ...changes.settings.newValue };
      if (fabEl) {
        fabEl.style.display = currentSettings.showFloatingButton ? 'flex' : 'none';
      }
      if (canvasEl) {
        canvasEl.style.display = currentSettings.notesVisible ? 'block' : 'none';
      }
    }

    if (changes.notes) {
      notesData = changes.notes.newValue || [];
      notesData.forEach(n => {
        const z = parseInt(n.zIndex, 10);
        if (!isNaN(z) && z > highestZIndex) {
          highestZIndex = z;
        }
      });
      renderCurrentPageNotes();
      updateFabBadge();
      updateFabButtonState();
    }
  });

  // Render all notes belonging to the current page
  function renderCurrentPageNotes() {
    if (!canvasEl) return;
    const pageUrl = getCurrentUrl();
    const activePageNotes = notesData.filter(n => n.url && n.url.split('#')[0] === pageUrl);

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
    fabEl.style.display = currentSettings.showFloatingButton ? 'flex' : 'none';

    fabEl.innerHTML = `
      <div class="fab-content" style="display: ${currentSettings.fabMinimized ? 'none' : 'flex'}; align-items: center; gap: 8px;">
        <button class="fab-btn fab-btn-primary" id="fab-add-btn" title="Add Sticky Note (Alt+Shift+N)">
          <span>➕</span>
          <span>New Note</span>
        </button>
        <div class="fab-separator"></div>
        <button class="fab-btn" id="fab-toggle-btn" title="Hide/Show Note">
          <span id="fab-toggle-icon">👁️</span>
        </button>
        <span class="fab-badge" id="fab-counter" title="Notes on this page">0</span>
        <button class="fab-btn" id="fab-collapse-btn" title="Minimize toolbar">
          <span>↘</span>
        </button>
      </div>
      <button class="fab-btn fab-mini-toggle" id="fab-mini-btn" style="display: ${currentSettings.fabMinimized ? 'flex' : 'none'}; padding: 6px;" title="Open Sticky Notes Toolbar">
        <span>📌</span>
      </button>

      <!-- Optional context popover to choose specific note to toggle -->
      <div class="fab-notes-popover" id="fab-notes-popover"></div>
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

  function toggleFabMinimize(minimized) {
    currentSettings.fabMinimized = minimized;
    fabEl.classList.toggle('minimized', minimized);
    const content = fabEl.querySelector('.fab-content');
    const miniBtn = fabEl.querySelector('#fab-mini-btn');
    if (content) content.style.display = minimized ? 'none' : 'flex';
    if (miniBtn) miniBtn.style.display = minimized ? 'flex' : 'none';
  }

  function updateFabBadge() {
    if (!fabEl) return;
    const pageUrl = getCurrentUrl();
    const count = notesData.filter(n => n.url && n.url.split('#')[0] === pageUrl).length;
    const counter = fabEl.querySelector('#fab-counter');
    if (counter) {
      counter.textContent = count.toString();
      counter.style.display = count > 0 ? 'inline-block' : 'none';
    }
    // Notify background for extension icon badge
    chrome.runtime.sendMessage({ action: 'UPDATE_BADGE' }).catch(() => {});
  }

  // Handle click on the Floating Quick Toolbar Hide/Show button
  // Shows/hides the specific Sticky Note popup (not all notes at once)
  function handleFabToggleClick() {
    const pageUrl = getCurrentUrl();
    const pageNotes = notesData.filter(n => n.url && n.url.split('#')[0] === pageUrl);
    if (pageNotes.length === 0) return;

    if (canvasEl && canvasEl.style.display === 'none') {
      canvasEl.style.display = 'block';
      currentSettings.notesVisible = true;
    }

    // 1. If there is a currently active note that is VISIBLE, clicking Hide/Show button hides that specific active note!
    let activeVisibleNote = null;
    if (lastActiveNoteId) {
      activeVisibleNote = pageNotes.find(n => n.id === lastActiveNoteId && !n.hidden);
    }

    if (activeVisibleNote) {
      setNoteHidden(activeVisibleNote.id, true);
      return;
    }

    // 2. Otherwise, if any note on this page is hidden, clicking Show shows that specific hidden popup again!
    const hiddenPageNotes = pageNotes.filter(n => n.hidden);
    if (hiddenPageNotes.length > 0) {
      let targetId = null;
      // Get the most recently hidden note from the stack that is still hidden
      for (let i = hiddenNotesStack.length - 1; i >= 0; i--) {
        if (hiddenPageNotes.some(n => n.id === hiddenNotesStack[i])) {
          targetId = hiddenNotesStack[i];
          break;
        }
      }
      if (!targetId) {
        targetId = hiddenPageNotes[hiddenPageNotes.length - 1].id;
      }

      setNoteHidden(targetId, false);
      return;
    }

    // 3. All notes are currently visible and none was specifically active: hide the topmost note
    const topmostVisible = [...pageNotes].filter(n => !n.hidden).sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0))[0];
    if (topmostVisible) {
      setNoteHidden(topmostVisible.id, true);
    }
  }

  // Update Hide/Show button icon & tooltip on the Floating Quick Toolbar
  function updateFabButtonState() {
    if (!fabEl) return;
    const pageUrl = getCurrentUrl();
    const pageNotes = notesData.filter(n => n.url && n.url.split('#')[0] === pageUrl);
    const hiddenNotes = pageNotes.filter(n => n.hidden);

    const toggleBtn = fabEl.querySelector('#fab-toggle-btn');
    const toggleIcon = fabEl.querySelector('#fab-toggle-icon');
    if (!toggleBtn || !toggleIcon) return;

    if (pageNotes.length === 0) {
      toggleIcon.textContent = '👁️';
      toggleBtn.title = 'No notes on this page';
      return;
    }

    // Check if there is an active visible note
    let activeVisibleNote = null;
    if (lastActiveNoteId) {
      activeVisibleNote = pageNotes.find(n => n.id === lastActiveNoteId && !n.hidden);
    }

    if (activeVisibleNote) {
      const title = ((activeVisibleNote.text) || 'Sticky Note').trim().slice(0, 20) || 'Sticky Note';
      toggleIcon.textContent = '👁️';
      toggleBtn.title = `Hide active note "${title}" (Right-click for all notes)`;
    } else if (hiddenNotes.length > 0) {
      let targetId = null;
      for (let i = hiddenNotesStack.length - 1; i >= 0; i--) {
        if (hiddenNotes.some(n => n.id === hiddenNotesStack[i])) {
          targetId = hiddenNotesStack[i];
          break;
        }
      }
      if (!targetId) targetId = hiddenNotes[hiddenNotes.length - 1].id;
      const targetNote = hiddenNotes.find(n => n.id === targetId) || hiddenNotes[0];
      const title = ((targetNote && targetNote.text) || 'Sticky Note').trim().slice(0, 20) || 'Sticky Note';
      toggleIcon.textContent = '🙈';
      toggleBtn.title = `Show hidden note "${title}" (Right-click for all notes)`;
    } else {
      const topmost = [...pageNotes].filter(n => !n.hidden).sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0))[0];
      const title = ((topmost && topmost.text) || 'Sticky Note').trim().slice(0, 20) || 'Sticky Note';
      toggleIcon.textContent = '👁️';
      toggleBtn.title = `Hide note "${title}" (Right-click for all notes)`;
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

    const pageUrl = getCurrentUrl();
    const pageNotes = notesData.filter(n => n.url && n.url.split('#')[0] === pageUrl);
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
        <div class="fab-popover-item ${n.hidden ? 'is-note-hidden' : ''}" data-id="${n.id}">
          <div class="fab-popover-title-wrapper">
            <span class="fab-popover-dot" style="background: ${dotColor};"></span>
            <span class="fab-popover-title">${escapeHtml(title)}</span>
          </div>
          <button class="fab-popover-btn" title="${n.hidden ? 'Show this note' : 'Hide this note'}">
            ${n.hidden ? '🙈' : '👁️'}
          </button>
        </div>
      `;
    }).join('');

    popover.innerHTML = `
      <div class="fab-popover-header">Page Notes (${pageNotes.length})</div>
      <div style="max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;">
        ${itemsHtml}
      </div>
    `;

    popover.querySelectorAll('.fab-popover-item').forEach(item => {
      const noteId = item.dataset.id;
      item.addEventListener('click', (e) => {
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
      });
    });

    popover.classList.add('open');
  }

  // Toggle Visibility of All Notes on Current Page (from extension shortcut or settings)
  function toggleVisibility() {
    currentSettings.notesVisible = !currentSettings.notesVisible;
    if (canvasEl) {
      canvasEl.style.display = currentSettings.notesVisible ? 'block' : 'none';
    }
    // Save setting to storage
    chrome.storage.local.get(['settings'], (res) => {
      const settings = res.settings || {};
      settings.notesVisible = currentSettings.notesVisible;
      chrome.storage.local.set({ settings });
    });
    updateFabButtonState();
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
      <div class="color-dot ${c.id === note.color ? 'active' : ''}" data-color="${c.id}" style="background: ${c.hex};" title="${c.id}"></div>
    `).join('');

    noteEl.innerHTML = `
      <div class="note-header">
        <div class="note-header-left">
          <span class="pin-indicator ${note.pinned ? 'pinned' : ''}" title="${note.pinned ? 'Pinned to screen (click to scroll with page)' : 'Scrolls with page (click to pin to screen)'}">
            ${note.pinned ? '📌' : '📍'}
          </span>
          <span class="note-title-preview" style="display: ${note.minimized ? 'inline' : 'none'}; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${escapeHtml(note.text || 'Note')}
          </span>
        </div>
        <div class="note-header-actions">
          <button class="icon-btn" id="btn-palette" title="Change Color">🎨</button>
          <button class="icon-btn" id="btn-checklist" title="${note.isChecklist ? 'Switch to Note' : 'Switch to Checklist'}">
            ${note.isChecklist ? '📝' : '☑️'}
          </button>
          <button class="icon-btn" id="btn-toggle-vis" title="Hide this note">👁️</button>
          <button class="icon-btn" id="btn-minimize" title="${note.minimized ? 'Expand' : 'Minimize'}">
            ${note.minimized ? '🗖' : '🗕'}
          </button>
          <button class="icon-btn danger" id="btn-delete" title="Delete Note">✕</button>
        </div>
      </div>

      <!-- Color Palette Popover -->
      <div class="palette-popover">
        ${paletteHtml}
      </div>

      <!-- Body / Checklist Container -->
      <div class="note-body-wrapper" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        ${renderNoteBodyContent(note)}
      </div>

      <!-- Footer -->
      <div class="note-footer">
        <span class="footer-time">${formatTimeAgo(note.updatedAt || note.createdAt)}</span>
        <span class="footer-status" style="opacity: 0.8;"></span>
      </div>

      <!-- Resize Grip -->
      <div class="resize-handle" title="Resize">
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

    // Update active dot in palette
    const palettePopover = noteEl.querySelector('.palette-popover');
    if (palettePopover) {
      palettePopover.querySelectorAll('.color-dot').forEach(dot => {
        dot.classList.toggle('active', dot.dataset.color === (note.color || 'yellow'));
      });
    }

    const visBtn = noteEl.querySelector('#btn-toggle-vis');
    if (visBtn) {
      visBtn.title = "Hide this note";
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
      }
    }
  }

  // Render note body (rich text vs checklist)
  function renderNoteBodyContent(note) {
    if (note.isChecklist) {
      const items = note.checklistItems || [];
      const itemsHtml = items.map((item, idx) => `
        <div class="checklist-item ${item.done ? 'done' : ''}" data-item-id="${item.id}">
          <input type="checkbox" ${item.done ? 'checked' : ''} />
          <input type="text" class="checklist-item-text" value="${escapeHtml(item.text)}" placeholder="To do item..." />
          <button class="checklist-item-delete" title="Remove item">✕</button>
        </div>
      `).join('');

      return `
        <div class="note-body checklist-container" style="overflow-y: auto;">
          <div class="checklist-items">${itemsHtml}</div>
          <button class="checklist-add-btn">
            <span>+</span> Add item
          </button>
        </div>
      `;
    } else {
      return `
        <div class="note-body" contenteditable="true" data-placeholder="Type your sticky note here...">${escapeHtml(note.text || '')}</div>
      `;
    }
  }

  // Setup interactions for note element
  function setupNoteEvents(noteEl, note) {
    const id = note.id;

    // Bring note to top immediately on ANY interaction
    // Use capture phase so it runs before any child handlers (contenteditable, inputs, checklist)
    const activateNote = (e) => {
      // If clicking an action button (hide, delete, color, etc.), do NOT reorder DOM during pointerdown/mousedown so the button click is never cancelled!
      const isActionButton = !!(e && e.target && e.target.closest && e.target.closest('button, .icon-btn, .color-dot, .checklist-item-delete, .resize-handle'));
      bringToFront(noteEl, id, !isActionButton);
    };

    noteEl.addEventListener('pointerdown', activateNote, true);
    noteEl.addEventListener('mousedown', activateNote, true);
    noteEl.addEventListener('focusin', activateNote, true);
    noteEl.addEventListener('touchstart', activateNote, { capture: true, passive: true });
    noteEl.addEventListener('click', activateNote, true);

    // Header actions
    const header = noteEl.querySelector('.note-header');
    const pinBtn = noteEl.querySelector('.pin-indicator');
    const paletteBtn = noteEl.querySelector('#btn-palette');
    const checklistBtn = noteEl.querySelector('#btn-checklist');
    const toggleVisBtn = noteEl.querySelector('#btn-toggle-vis');
    const minimizeBtn = noteEl.querySelector('#btn-minimize');
    const deleteBtn = noteEl.querySelector('#btn-delete');
    const palettePopover = noteEl.querySelector('.palette-popover');
    const resizeHandle = noteEl.querySelector('.resize-handle');

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
        dot.classList.toggle('active', dot.dataset.color === newColor);
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

    // Close palette on click outside using composedPath across Shadow DOM
    const handleOutsideClick = (e) => {
      if (!palettePopover.classList.contains('open')) return;
      const path = e.composedPath();
      if (!path.includes(palettePopover) && !path.includes(paletteBtn)) {
        palettePopover.classList.remove('open');
      }
    };
    document.addEventListener('pointerdown', handleOutsideClick);

    // Checklist mode switch
    checklistBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = notesData.find(n => n.id === id);
      if (!current) return;

      current.isChecklist = !current.isChecklist;
      if (current.isChecklist && (!current.checklistItems || current.checklistItems.length === 0)) {
        // Convert lines of text to checklist items
        const lines = (current.text || '').split('\n').map(l => l.trim()).filter(Boolean);
        current.checklistItems = lines.length ? lines.map(line => ({
          id: 'item_' + Math.random().toString(36).substring(2, 6),
          text: line,
          done: false
        })) : [{
          id: 'item_' + Math.random().toString(36).substring(2, 6),
          text: '',
          done: false
        }];
      } else if (!current.isChecklist) {
        // Convert checklist items back to plain text
        current.text = (current.checklistItems || []).map(i => (i.done ? '[x] ' : '[ ] ') + i.text).join('\n');
      }

      current.updatedAt = Date.now();
      checklistBtn.textContent = current.isChecklist ? '📝' : '☑️';
      checklistBtn.title = current.isChecklist ? 'Switch to Note' : 'Switch to Checklist';

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

      const preview = noteEl.querySelector('.note-title-preview');
      if (preview) {
        preview.style.display = current.minimized ? 'inline' : 'none';
        preview.textContent = current.text || 'Note';
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

      // Enter key adds new item
      container.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('checklist-item-text') && e.key === 'Enter') {
          e.preventDefault();
          addNewChecklistItem(noteEl, id);
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

  function addNewChecklistItem(noteEl, noteId) {
    const current = notesData.find(n => n.id === noteId);
    if (!current) return;
    if (!current.checklistItems) current.checklistItems = [];

    const newItem = {
      id: 'item_' + Math.random().toString(36).substring(2, 6),
      text: '',
      done: false
    };
    current.checklistItems.push(newItem);

    const container = noteEl.querySelector('.checklist-items');
    const itemEl = document.createElement('div');
    itemEl.className = 'checklist-item';
    itemEl.dataset.itemId = newItem.id;
    itemEl.innerHTML = `
      <input type="checkbox" />
      <input type="text" class="checklist-item-text" value="" placeholder="To do item..." />
      <button class="checklist-item-delete" title="Remove item">✕</button>
    `;
    container.appendChild(itemEl);

    const input = itemEl.querySelector('.checklist-item-text');
    input.focus();
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

      // Keep within bounds
      newX = Math.max(10, newX);
      newY = Math.max(10, newY);

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

      const newWidth = Math.max(200, origWidth + dx);
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
  function bringToFront(noteEl, id, reorderDom = true) {
    lastActiveNoteId = id;

    // 1. Calculate max z-index across all rendered note elements & stored notes
    let maxZ = 2147483640;
    notesMap.forEach((el) => {
      el.classList.remove('is-active-note');
      const z = parseInt(el.style.zIndex, 10);
      if (!isNaN(z) && z > maxZ) {
        maxZ = z;
      }
    });
    notesData.forEach((n) => {
      const z = parseInt(n.zIndex, 10);
      if (!isNaN(z) && z > maxZ) {
        maxZ = z;
      }
    });

    highestZIndex = Math.max(highestZIndex, maxZ) + 2;
    noteEl.style.zIndex = highestZIndex;
    noteEl.classList.add('is-active-note');

    // 2. Only reorder in DOM if explicitly safe (not during button clicks) AND not already last child!
    // Never reorder during button clicks because re-attaching DOM nodes cancels click events in Chromium!
    if (reorderDom && canvasEl && noteEl.parentElement === canvasEl && canvasEl.lastElementChild !== noteEl) {
      canvasEl.appendChild(noteEl);
    }

    // 3. Update the data model
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

    lastDeletedNote = { ...notesData[idx] };
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
    toast.innerHTML = `
      <span>Note deleted</span>
      <button id="toast-undo-btn">Undo</button>
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

    if (request.action === 'HIGHLIGHT_NOTE') {
      const { noteId } = request;
      const noteEl = notesMap.get(noteId);
      if (noteEl) {
        // Unhide if hidden
        setNoteHidden(noteId, false);

        // Expand if minimized
        if (noteEl.classList.contains('minimized')) {
          noteEl.classList.remove('minimized');
          const current = notesData.find(n => n.id === noteId);
          if (current) current.minimized = false;
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
