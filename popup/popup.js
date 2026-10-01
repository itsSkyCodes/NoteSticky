// NoteSticky - Popup Dashboard Logic

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const notesGrid = document.getElementById('notes-grid');
  const emptyState = document.getElementById('empty-state');
  const emptyTitle = document.getElementById('empty-title');
  const emptyDesc = document.getElementById('empty-desc');
  const emptyAddBtn = document.getElementById('empty-add-btn');
  const searchInput = document.getElementById('search-input');
  const searchClearBtn = document.getElementById('search-clear-btn');
  const filterTabs = document.getElementById('filter-tabs');
  const colorFilters = document.getElementById('color-filter-container');
  const countCurrentEl = document.getElementById('count-current');
  const countAllEl = document.getElementById('count-all');
  const countChecklistsEl = document.getElementById('count-checklists');
  const footerStats = document.getElementById('footer-stats');
  const btnAddNote = document.getElementById('btn-add-note');
  const btnHeaderVisibility = document.getElementById('btn-header-visibility');
  const headerVisIcon = document.getElementById('header-vis-icon');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const settingsToggleBtn = document.getElementById('settings-toggle-btn');
  const settingsModal = document.getElementById('settings-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const popupToast = document.getElementById('popup-toast');

  // Settings elements
  const settingFloatingBtn = document.getElementById('setting-floating-btn');
  const settingPinMode = document.getElementById('setting-pin-mode');
  const settingDefaultColor = document.getElementById('setting-default-color');
  const settingTogglePageVis = document.getElementById('setting-toggle-page-vis');
  const btnClearPageNotes = document.getElementById('btn-clear-page-notes');
  const btnClearAllNotes = document.getElementById('btn-clear-all-notes');

  // Export / Import elements
  const btnExportMd = document.getElementById('btn-export-md');
  const btnExportJson = document.getElementById('btn-export-json');
  const importJsonInput = document.getElementById('import-json-input');

  // State
  let currentTab = null;
  let allNotes = [];
  let currentSettings = {
    notesVisible: true,
    defaultColor: 'yellow',
    theme: 'system',
    showFloatingButton: true,
    pinMode: 'page'
  };
  let activeFilter = 'current-page'; // 'current-page' | 'all' | 'checklists'
  let activeColorFilter = 'all';
  let searchQuery = '';

  // 1. Get current active tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      currentTab = tabs[0];
    }
  } catch (err) {
    console.error('Error fetching active tab:', err);
  }

  const currentUrl = currentTab && currentTab.url ? currentTab.url.split('#')[0] : '';
  const currentDomain = currentTab && currentTab.url ? new URL(currentTab.url).hostname : '';

  // 2. Load settings & notes
  function loadData() {
    chrome.storage.local.get(['notes', 'settings'], (res) => {
      allNotes = res.notes || [];
      if (res.settings) {
        currentSettings = { ...currentSettings, ...res.settings };
      }
      updateHeaderVisIcon(currentSettings.notesVisible !== false);
      applyTheme(currentSettings.theme);
      syncSettingsUI();
      render();
    });
  }

  // Listen for storage changes from webpage content scripts or other tabs
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let shouldReRender = false;

    if (changes.notes) {
      allNotes = changes.notes.newValue || [];
      shouldReRender = true;
    }

    if (changes.settings) {
      currentSettings = { ...currentSettings, ...changes.settings.newValue };
      updateHeaderVisIcon(currentSettings.notesVisible !== false);
      syncSettingsUI();
      applyTheme(currentSettings.theme);
    }

    if (shouldReRender) {
      render();
    }
  });

  // Sync settings UI in modal
  function syncSettingsUI() {
    settingFloatingBtn.checked = !!currentSettings.showFloatingButton;
    settingPinMode.value = currentSettings.pinMode || 'page';
    settingDefaultColor.value = currentSettings.defaultColor || 'yellow';
  }

  // Apply theme
  function applyTheme(theme) {
    let isDark = false;
    if (theme === 'dark') {
      isDark = true;
    } else if (theme === 'light') {
      isDark = false;
    } else {
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    if (isDark) {
      document.body.setAttribute('data-theme', 'dark');
      themeToggleBtn.querySelector('.theme-icon').textContent = '☀️';
    } else {
      document.body.removeAttribute('data-theme');
      themeToggleBtn.querySelector('.theme-icon').textContent = '🌙';
    }
  }

  // 3. Filter and Search Notes
  function getFilteredNotes() {
    return allNotes.filter(note => {
      // Tab filter
      if (activeFilter === 'current-page') {
        const noteUrl = note.url ? note.url.split('#')[0] : '';
        if (noteUrl !== currentUrl) return false;
      } else if (activeFilter === 'checklists') {
        if (!note.isChecklist) return false;
      }

      // Color filter
      if (activeColorFilter !== 'all') {
        if (note.color !== activeColorFilter) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const textMatch = (note.text || '').toLowerCase().includes(q);
        const titleMatch = (note.pageTitle || '').toLowerCase().includes(q);
        const domainMatch = (note.domain || '').toLowerCase().includes(q);
        const checklistMatch = note.checklistItems && note.checklistItems.some(item => (item.text || '').toLowerCase().includes(q));
        if (!textMatch && !titleMatch && !domainMatch && !checklistMatch) return false;
      }

      return true;
    }).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  }

  // 4. Render Notes
  function render() {
    // Update count badges
    const currentCount = allNotes.filter(n => n.url && n.url.split('#')[0] === currentUrl).length;
    const allCount = allNotes.length;
    const checklistCount = allNotes.filter(n => n.isChecklist).length;

    countCurrentEl.textContent = currentCount.toString();
    countAllEl.textContent = allCount.toString();
    countChecklistsEl.textContent = checklistCount.toString();

    const filtered = getFilteredNotes();
    footerStats.textContent = `${filtered.length} of ${allNotes.length} notes`;

    // Empty state handling
    if (filtered.length === 0) {
      notesGrid.innerHTML = '';
      emptyState.style.display = 'flex';

      if (searchQuery.trim()) {
        emptyTitle.textContent = 'No matching notes';
        emptyDesc.textContent = `No notes found matching "${searchQuery}".`;
        emptyAddBtn.style.display = 'none';
      } else if (activeFilter === 'current-page') {
        emptyTitle.textContent = 'No notes on this page';
        emptyDesc.textContent = 'Create a sticky note on this webpage to keep thoughts and reminders handy.';
        emptyAddBtn.style.display = 'inline-flex';
      } else if (activeFilter === 'checklists') {
        emptyTitle.textContent = 'No checklists found';
        emptyDesc.textContent = 'You can convert any sticky note into an interactive checklist!';
        emptyAddBtn.style.display = 'inline-flex';
      } else {
        emptyTitle.textContent = 'No sticky notes yet';
        emptyDesc.textContent = 'Click "New Note" to pin your first sticky note anywhere!';
        emptyAddBtn.style.display = 'inline-flex';
      }
      return;
    }

    emptyState.style.display = 'none';

    // Render cards
    notesGrid.innerHTML = filtered.map(note => {
      return createCardHtml(note);
    }).join('');

    // Attach card action listeners
    attachCardListeners();
  }

  // Create Card HTML
  function createCardHtml(note) {
    const isThisPage = note.url && note.url.split('#')[0] === currentUrl;
    const timeAgo = formatTimeAgo(note.updatedAt || note.createdAt);

    let contentHtml = '';
    if (note.isChecklist) {
      const items = note.checklistItems || [];
      const doneCount = items.filter(i => i.done).length;
      const previewItems = items.slice(0, 3).map(item => `
        <div class="checklist-preview-item ${item.done ? 'done' : ''}">
          <span>${item.done ? '☑' : '☐'}</span>
          <span>${escapeHtml(item.text || 'Untitled')}</span>
        </div>
      `).join('');

      contentHtml = `
        <div class="checklist-preview-list">
          <div style="font-size: 11px; font-weight: 600; opacity: 0.8; margin-bottom: 2px;">
            Progress: ${doneCount}/${items.length} completed
          </div>
          ${previewItems}
          ${items.length > 3 ? `<div style="font-size: 11px; opacity: 0.6;">+${items.length - 3} more items...</div>` : ''}
        </div>
      `;
    } else {
      contentHtml = `
        <div class="note-card-content">
          ${escapeHtml(note.text || 'Empty note')}
        </div>
      `;
    }

    return `
      <div class="note-card card-theme-${note.color || 'yellow'}" data-note-id="${note.id}">
        <div class="note-card-header">
          <div class="note-card-domain" title="${escapeHtml(note.pageTitle || note.domain || 'Note')}">
            <span>🌐</span>
            <span>${escapeHtml(note.domain || 'Webpage')}</span>
          </div>
          <div class="note-card-actions">
            <button class="card-btn btn-card-vis" title="${note.hidden ? 'Show note on page' : 'Hide note on page'}">
              ${note.hidden ? '🙈' : '👁️'}
            </button>
            <button class="card-btn btn-card-color" title="Change Color">🎨</button>
            <button class="card-btn btn-card-copy" title="Copy Content">📋</button>
            <button class="card-btn btn-card-delete" title="Delete Note">✕</button>
          </div>
        </div>

        <!-- Inline Card Color Palette Popover -->
        <div class="card-palette-popover">
          <div class="card-color-dot ${note.color === 'yellow' ? 'active' : ''}" data-color="yellow" style="background: #FEF08A;" title="Yellow"></div>
          <div class="card-color-dot ${note.color === 'mint' ? 'active' : ''}" data-color="mint" style="background: #BBF7D0;" title="Mint"></div>
          <div class="card-color-dot ${note.color === 'coral' ? 'active' : ''}" data-color="coral" style="background: #FECDD3;" title="Coral"></div>
          <div class="card-color-dot ${note.color === 'lavender' ? 'active' : ''}" data-color="lavender" style="background: #E9D5FF;" title="Lavender"></div>
          <div class="card-color-dot ${note.color === 'sky' ? 'active' : ''}" data-color="sky" style="background: #BAE6FD;" title="Sky"></div>
          <div class="card-color-dot ${note.color === 'peach' ? 'active' : ''}" data-color="peach" style="background: #FED7AA;" title="Peach"></div>
          <div class="card-color-dot ${note.color === 'slate' ? 'active' : ''}" data-color="slate" style="background: #1E293B;" title="Slate"></div>
        </div>

        ${contentHtml}

        <div class="note-card-footer">
          <span>${timeAgo}</span>
          <button class="card-jump-btn btn-card-jump" title="Open and jump to this note on webpage">
            <span>🚀</span>
            <span>${isThisPage ? 'Focus on Page' : 'Jump to Page'}</span>
          </button>
        </div>
      </div>
    `;
  }

  // Attach Card Event Listeners
  function attachCardListeners() {
    notesGrid.querySelectorAll('.note-card').forEach(card => {
      const id = card.dataset.noteId;
      const note = allNotes.find(n => n.id === id);
      if (!note) return;

      // Toggle note visibility on page
      card.querySelector('.btn-card-vis').addEventListener('click', () => {
        note.hidden = !note.hidden;
        note.updatedAt = Date.now();
        saveAndRender();
        showToast(note.hidden ? 'Note hidden on page' : 'Note shown on page');
      });

      // Jump to note
      card.querySelector('.btn-card-jump').addEventListener('click', () => {
        jumpToNote(note);
      });

      // Copy content
      card.querySelector('.btn-card-copy').addEventListener('click', () => {
        let textToCopy = '';
        if (note.isChecklist) {
          textToCopy = (note.checklistItems || []).map(i => `${i.done ? '[x]' : '[ ]'} ${i.text}`).join('\n');
        } else {
          textToCopy = note.text || '';
        }
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast('Copied to clipboard!');
        });
      });

      // Palette toggle and selection
      const colorBtn = card.querySelector('.btn-card-color');
      const palettePopover = card.querySelector('.card-palette-popover');
      if (colorBtn && palettePopover) {
        colorBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Close other open card palettes
          notesGrid.querySelectorAll('.card-palette-popover.open').forEach(p => {
            if (p !== palettePopover) p.classList.remove('open');
          });
          palettePopover.classList.toggle('open');
        });

        palettePopover.addEventListener('click', (e) => {
          e.stopPropagation();
          const dot = e.target.closest('.card-color-dot');
          if (dot && dot.dataset.color) {
            note.color = dot.dataset.color;
            note.updatedAt = Date.now();
            palettePopover.classList.remove('open');
            saveAndRender();
          }
        });
      }

      // Delete with Undo
      card.querySelector('.btn-card-delete').addEventListener('click', () => {
        deleteNoteWithUndo(id);
      });
    });
  }

  // Close open card color palettes on click outside
  document.addEventListener('pointerdown', (e) => {
    const openPalettes = notesGrid.querySelectorAll('.card-palette-popover.open');
    if (openPalettes.length === 0) return;
    const path = e.composedPath();
    openPalettes.forEach(popover => {
      const card = popover.closest('.note-card');
      const btn = card ? card.querySelector('.btn-card-color') : null;
      if (!path.includes(popover) && (!btn || !path.includes(btn))) {
        popover.classList.remove('open');
      }
    });
  });

  // Jump to Note on Webpage
  function jumpToNote(note) {
    if (!note.url) {
      showToast('No URL associated with this note.');
      return;
    }
    chrome.runtime.sendMessage({
      action: 'FOCUS_NOTE',
      noteId: note.id,
      url: note.url
    }, () => {
      window.close(); // Close popup so user is on the page
    });
  }

  // Delete note with 4.5s Undo toast
  let lastDeletedNote = null;
  function deleteNoteWithUndo(id) {
    const idx = allNotes.findIndex(n => n.id === id);
    if (idx === -1) return;

    lastDeletedNote = JSON.parse(JSON.stringify(allNotes[idx]));
    allNotes.splice(idx, 1);
    saveAndRender();

    showUndoToast('Note deleted', () => {
      if (lastDeletedNote) {
        allNotes.push(lastDeletedNote);
        saveAndRender();
        lastDeletedNote = null;
      }
    });
  }

  function saveAndRender() {
    chrome.storage.local.set({ notes: allNotes }, () => {
      render();
      chrome.runtime.sendMessage({
        action: 'UPDATE_BADGE',
        tabId: currentTab ? currentTab.id : undefined,
        url: currentUrl
      }).catch(() => {});
    });
  }

  // Create New Note from Header Button
  function createNewNoteOnCurrentPage() {
    if (!currentTab || !currentTab.id) {
      showToast('Could not access current tab.');
      return;
    }

    // Try sending message to content script
    chrome.tabs.sendMessage(currentTab.id, { action: 'CREATE_NOTE' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        // Content script might not run on chrome:// or webstore URLs
        // Create directly in storage
        const fallbackNote = {
          id: 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
          text: '',
          url: currentUrl || 'https://google.com',
          domain: currentDomain || 'Web',
          pageTitle: (currentTab && currentTab.title) || 'Sticky Note',
          color: currentSettings.defaultColor || 'yellow',
          x: 100,
          y: 100,
          width: 250,
          height: 220,
          pinned: false,
          minimized: false,
          isChecklist: false,
          checklistItems: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        allNotes.push(fallbackNote);
        saveAndRender();
        showToast('Created general note!');
      } else {
        showToast('Added sticky note to page!');
        window.close();
      }
    });
  }

  btnAddNote.addEventListener('click', createNewNoteOnCurrentPage);
  emptyAddBtn.addEventListener('click', createNewNoteOnCurrentPage);

  // Header visibility toggle
  if (btnHeaderVisibility) {
    btnHeaderVisibility.addEventListener('click', () => {
      if (!currentTab || !currentTab.id) return;
      chrome.tabs.sendMessage(currentTab.id, { action: 'TOGGLE_VISIBILITY' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          currentSettings.notesVisible = !currentSettings.notesVisible;
          chrome.storage.local.set({ settings: currentSettings });
          updateHeaderVisIcon(currentSettings.notesVisible);
          showToast(currentSettings.notesVisible ? 'Sticky notes shown' : 'Sticky notes hidden');
        } else {
          const isVis = res.visible !== undefined ? res.visible : !currentSettings.notesVisible;
          currentSettings.notesVisible = isVis;
          updateHeaderVisIcon(isVis);
          showToast(isVis ? 'Sticky notes shown' : 'Sticky notes hidden');
        }
      });
    });
  }

  function updateHeaderVisIcon(visible) {
    if (headerVisIcon) {
      headerVisIcon.textContent = visible ? '👁️' : '🙈';
    }
    if (btnHeaderVisibility) {
      btnHeaderVisibility.title = visible ? 'Hide Notes on Page (Alt+Shift+H)' : 'Show Notes on Page (Alt+Shift+H)';
    }
  }

  // Search input handling
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    searchClearBtn.style.display = searchQuery ? 'block' : 'none';
    render();
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClearBtn.style.display = 'none';
    render();
    searchInput.focus();
  });

  // Filter tabs click
  filterTabs.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;

    filterTabs.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    render();
  });

  // Color filter dots click
  colorFilters.addEventListener('click', (e) => {
    const dot = e.target.closest('.color-filter-dot');
    if (!dot) return;

    colorFilters.querySelectorAll('.color-filter-dot').forEach(d => d.classList.remove('active'));
    dot.classList.add('active');
    activeColorFilter = dot.dataset.color;
    render();
  });

  // Theme toggle
  themeToggleBtn.addEventListener('click', () => {
    const isDarkNow = document.body.getAttribute('data-theme') === 'dark';
    const newTheme = isDarkNow ? 'light' : 'dark';
    currentSettings.theme = newTheme;
    chrome.storage.local.set({ settings: currentSettings });
    applyTheme(newTheme);
  });

  // Settings modal functions with accessibility and focus trapping
  function openSettingsModal() {
    settingsModal.style.display = 'flex';
    modalCloseBtn.focus();
  }

  function closeSettingsModal() {
    settingsModal.style.display = 'none';
    settingsToggleBtn.focus();
  }

  settingsToggleBtn.addEventListener('click', openSettingsModal);
  modalCloseBtn.addEventListener('click', closeSettingsModal);

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      closeSettingsModal();
    }
  });

  // Modal keyboard trap & Escape key listener
  document.addEventListener('keydown', (e) => {
    if (settingsModal.style.display === 'flex') {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSettingsModal();
        return;
      }

      if (e.key === 'Tab') {
        const focusable = settingsModal.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const firstEl = focusable[0];
        const lastEl = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstEl) {
            e.preventDefault();
            lastEl.focus();
          }
        } else {
          if (document.activeElement === lastEl) {
            e.preventDefault();
            firstEl.focus();
          }
        }
      }
    } else if (e.key === 'Escape') {
      // Close open card color palettes on Escape
      const openPalettes = notesGrid.querySelectorAll('.card-palette-popover.open');
      if (openPalettes.length > 0) {
        e.preventDefault();
        openPalettes.forEach(p => p.classList.remove('open'));
      }
    }
  });

  // Keyboard accessibility for file import label button
  const importLabel = document.querySelector('label[for="import-json-input"]');
  if (importLabel) {
    importLabel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        importJsonInput.click();
      }
    });
  }

  // Settings changes
  settingFloatingBtn.addEventListener('change', (e) => {
    currentSettings.showFloatingButton = e.target.checked;
    chrome.storage.local.set({ settings: currentSettings });
  });

  settingPinMode.addEventListener('change', (e) => {
    currentSettings.pinMode = e.target.value;
    chrome.storage.local.set({ settings: currentSettings });
  });

  settingDefaultColor.addEventListener('change', (e) => {
    currentSettings.defaultColor = e.target.value;
    chrome.storage.local.set({ settings: currentSettings });
  });

  settingTogglePageVis.addEventListener('click', () => {
    if (currentTab && currentTab.id) {
      chrome.tabs.sendMessage(currentTab.id, { action: 'TOGGLE_VISIBILITY' }, (res) => {
        if (chrome.runtime.lastError) {
          showToast('Cannot toggle on this page.');
        } else {
          showToast('Visibility toggled.');
        }
      });
    }
  });

  // Clear notes on current page
  btnClearPageNotes.addEventListener('click', () => {
    if (!confirm('Are you sure you want to delete all notes on this page?')) return;
    allNotes = allNotes.filter(n => (n.url ? n.url.split('#')[0] : '') !== currentUrl);
    saveAndRender();
    showToast('Page notes deleted.');
    settingsModal.style.display = 'none';
  });

  // Clear all notes
  btnClearAllNotes.addEventListener('click', () => {
    if (!confirm('CAUTION: Are you sure you want to delete ALL sticky notes across all websites? This cannot be undone.')) return;
    allNotes = [];
    saveAndRender();
    showToast('All notes cleared.');
    settingsModal.style.display = 'none';
  });

  // Export as Markdown
  btnExportMd.addEventListener('click', () => {
    if (allNotes.length === 0) {
      showToast('No notes to export.');
      return;
    }

    let md = `# NoteSticky - Exported Notes (${new Date().toLocaleDateString()})\n\n`;

    allNotes.forEach((note, idx) => {
      md += `## ${idx + 1}. ${note.pageTitle || note.domain || 'Sticky Note'}\n`;
      md += `- **URL:** ${note.url || 'None'}\n`;
      md += `- **Created:** ${new Date(note.createdAt).toLocaleString()}\n`;
      md += `- **Color:** ${note.color}\n\n`;

      if (note.isChecklist) {
        md += `### Checklist:\n\n`;
        (note.checklistItems || []).forEach(item => {
          md += `- [${item.done ? 'x' : ' '}] ${item.text || 'Untitled'}\n`;
        });
      } else {
        md += `${(note.text || '').trim() || '_Empty note_'}\n`;
      }
      md += `\n---\n\n`;
    });

    downloadBlob(md, `NoteSticky_Notes_${Date.now()}.md`, 'text/markdown');
    showToast('Markdown exported!');
  });

  // Export as JSON backup
  btnExportJson.addEventListener('click', () => {
    if (allNotes.length === 0) {
      showToast('No notes to backup.');
      return;
    }
    const backupData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      notes: allNotes,
      settings: currentSettings
    };
    downloadBlob(JSON.stringify(backupData, null, 2), `NoteSticky_Backup_${Date.now()}.json`, 'application/json');
    showToast('Backup JSON downloaded!');
  });

  // Import JSON backup
  importJsonInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (data.notes && Array.isArray(data.notes)) {
          // Merge unique notes
          const existingIds = new Set(allNotes.map(n => n.id));
          const newNotes = data.notes.filter(n => !existingIds.has(n.id));
          allNotes = [...allNotes, ...newNotes];
          saveAndRender();
          showToast(`Imported ${newNotes.length} notes!`);
        } else {
          showToast('Invalid backup file format.');
        }
      } catch (err) {
        showToast('Error parsing JSON backup.');
      }
      importJsonInput.value = '';
    };
    reader.readAsText(file);
  });

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  let popupToastTimeout = null;
  function showToast(message) {
    if (popupToastTimeout) clearTimeout(popupToastTimeout);
    popupToast.textContent = message;
    popupToast.style.display = 'flex';
    popupToastTimeout = setTimeout(() => {
      popupToast.style.display = 'none';
    }, 2400);
  }

  function showUndoToast(message, onUndo) {
    if (popupToastTimeout) clearTimeout(popupToastTimeout);
    popupToast.innerHTML = `
      <span>${escapeHtml(message)}</span>
      <button id="popup-undo-btn" class="toast-undo-btn">Undo</button>
    `;
    popupToast.style.display = 'flex';

    const undoBtn = popupToast.querySelector('#popup-undo-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onUndo) onUndo();
        popupToast.style.display = 'none';
      });
    }

    popupToastTimeout = setTimeout(() => {
      popupToast.style.display = 'none';
      lastDeletedNote = null;
    }, 4500);
  }

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

  // Start initialization
  loadData();
});
