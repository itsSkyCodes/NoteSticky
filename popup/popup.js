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
  let editingNoteId = null;

  // 1. Get current active tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      currentTab = tabs[0];
    }
  } catch (err) {
    console.error('Error fetching active tab:', err);
  }

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

  const currentUrl = currentTab && currentTab.url ? currentTab.url.split('#')[0] : '';
  const currentDomain = currentTab && currentTab.url ? extractDomain(currentTab.url) : '';

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
    settingFloatingBtn.checked = currentSettings.showFloatingButton !== false;
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
        const noteDomain = (note.domain || extractDomain(note.url) || '').toLowerCase();
        if (!currentDomain || noteDomain !== currentDomain) return false;
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
    const currentCount = allNotes.filter(n => {
      const noteDomain = (n.domain || extractDomain(n.url) || '').toLowerCase();
      return currentDomain && noteDomain === currentDomain;
    }).length;
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
        emptyTitle.textContent = 'No notes on this domain';
        emptyDesc.textContent = currentDomain
          ? `Create a sticky note on ${currentDomain} to keep thoughts and reminders handy across all pages.`
          : 'Create a sticky note on this domain to keep thoughts and reminders handy.';
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

  // Helper to determine if a note has any non-empty content
  function noteHasContent(note) {
    if (!note) return false;
    if (note.isChecklist) {
      return Array.isArray(note.checklistItems) &&
        note.checklistItems.some(item => item && item.text && item.text.trim().length > 0);
    }
    return Boolean(note.text && note.text.trim().length > 0);
  }

  // Update disabled state & tooltip of a card's copy button dynamically
  function updateCardCopyButton(card, note) {
    if (!card || !note) return;
    const copyBtn = card.querySelector('.btn-card-copy');
    if (!copyBtn) return;

    let hasText = false;
    if (editingNoteId === note.id) {
      if (note.isChecklist) {
        const inputs = card.querySelectorAll('.checklist-edit-text');
        hasText = Array.from(inputs).some(input => input.value && input.value.trim().length > 0);
      } else {
        const textarea = card.querySelector('.note-card-edit-textarea');
        hasText = Boolean(textarea && textarea.value && textarea.value.trim().length > 0);
      }
    } else {
      hasText = noteHasContent(note);
    }

    copyBtn.disabled = !hasText;
    copyBtn.title = hasText ? 'Copy Content' : 'No content to copy';
    copyBtn.setAttribute('aria-label', hasText ? 'Copy Content' : 'No content to copy');
  }

  // Create Card HTML
  function createCardHtml(note) {
    const noteDomain = (note.domain || extractDomain(note.url) || '').toLowerCase();
    const isThisDomain = Boolean(currentDomain && noteDomain === currentDomain);
    const timeAgo = formatTimeAgo(note.updatedAt || note.createdAt);
    const isEditing = editingNoteId === note.id;
    const hasContent = noteHasContent(note);

    let contentHtml = '';
    if (isEditing) {
      if (note.isChecklist) {
        const items = note.checklistItems || [];
        const rowsHtml = items.map((item, idx) => `
          <div class="checklist-edit-row" data-index="${idx}">
            <input type="checkbox" class="checklist-edit-checkbox" ${item.done ? 'checked' : ''} aria-label="Mark done">
            <input type="text" class="checklist-edit-text" value="${escapeHtml(item.text || '')}" placeholder="List item...">
            <button type="button" class="checklist-edit-del-btn" title="Remove item">✕</button>
          </div>
        `).join('');

        contentHtml = `
          <div class="note-card-edit-container checklist-edit-container">
            <div class="checklist-edit-items">
              ${rowsHtml}
            </div>
            <button type="button" class="checklist-edit-add-btn" aria-label="Add new item">+ Add item</button>
            <div class="note-card-edit-actions">
              <button type="button" class="btn-edit-save" title="Save changes (Ctrl+Enter)">✓ Save</button>
              <button type="button" class="btn-edit-cancel" title="Cancel editing (Esc)">✕ Cancel</button>
            </div>
          </div>
        `;
      } else {
        contentHtml = `
          <div class="note-card-edit-container">
            <textarea class="note-card-edit-textarea" rows="4" placeholder="Edit note content...">${escapeHtml(note.text || '')}</textarea>
            <div class="note-card-edit-actions">
              <button type="button" class="btn-edit-save" title="Save changes (Ctrl+Enter)">✓ Save</button>
              <button type="button" class="btn-edit-cancel" title="Cancel editing (Esc)">✕ Cancel</button>
            </div>
          </div>
        `;
      }
    } else {
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
          <div class="checklist-preview-list clickable" title="Click to edit checklist">
            <div style="font-size: 11px; font-weight: 600; opacity: 0.8; margin-bottom: 2px;">
              Progress: ${doneCount}/${items.length} completed
            </div>
            ${previewItems}
            ${items.length > 3 ? `<div style="font-size: 11px; opacity: 0.6;">+${items.length - 3} more items...</div>` : ''}
          </div>
        `;
      } else {
        contentHtml = `
          <div class="note-card-content clickable" title="Click to edit note">
            ${escapeHtml(note.text || 'Empty note')}
          </div>
        `;
      }
    }

    return `
      <div class="note-card card-theme-${note.color || 'yellow'} ${isEditing ? 'is-editing' : ''}" data-note-id="${note.id}">
        <div class="note-card-header">
          <div class="note-card-domain" title="${escapeHtml(note.pageTitle || note.domain || 'Note')}">
            <span>🌐</span>
            <span>${escapeHtml(note.domain || 'Webpage')}</span>
          </div>
          <div class="note-card-actions">
            <button class="card-btn btn-card-edit ${isEditing ? 'active' : ''}" title="${isEditing ? 'Close editor' : 'Edit note'}" aria-label="Edit note content">✏️</button>
            <button class="card-btn btn-card-vis" title="${note.hidden ? 'Show note on page' : 'Hide note on page'}" aria-label="${note.hidden ? 'Show note on page' : 'Hide note on page'}">
              ${note.hidden ? '🙈' : '👁️'}
            </button>
            <button class="card-btn btn-card-color" title="Change Color">🎨</button>
            <button class="card-btn btn-card-copy" ${!hasContent ? 'disabled' : ''} title="${!hasContent ? 'No content to copy' : 'Copy Content'}" aria-label="${!hasContent ? 'No content to copy' : 'Copy Content'}">📋</button>
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
            <span>${isThisDomain ? 'Focus on Page' : 'Jump to Page'}</span>
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
      const isEditing = editingNoteId === id;

      // Edit Note button
      const editBtn = card.querySelector('.btn-card-edit');
      if (editBtn) {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (editingNoteId === id) {
            editingNoteId = null;
            render();
          } else {
            editingNoteId = id;
            render();
            focusCardEditor(id);
          }
        });
      }

      // Clicking on non-editing content enters edit mode
      const clickableContent = card.querySelector('.note-card-content.clickable, .checklist-preview-list.clickable');
      if (clickableContent) {
        clickableContent.addEventListener('click', (e) => {
          e.stopPropagation();
          editingNoteId = id;
          render();
          focusCardEditor(id);
        });
      }

      // Save edit button
      const saveBtn = card.querySelector('.btn-edit-save');
      if (saveBtn) {
        saveBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          saveCardEdit(id, card);
        });
      }

      // Cancel edit button
      const cancelBtn = card.querySelector('.btn-edit-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!note.text && (!note.checklistItems || note.checklistItems.length === 0)) {
            const idx = allNotes.findIndex(n => n.id === id);
            if (idx !== -1) allNotes.splice(idx, 1);
          }
          editingNoteId = null;
          saveAndRender();
        });
      }

      // Textarea keyboard shortcuts: Ctrl/Cmd+Enter to save, Esc to cancel
      const textarea = card.querySelector('.note-card-edit-textarea');
      if (textarea) {
        textarea.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            saveCardEdit(id, card);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            if (!note.text && (!note.checklistItems || note.checklistItems.length === 0)) {
              const idx = allNotes.findIndex(n => n.id === id);
              if (idx !== -1) allNotes.splice(idx, 1);
            }
            editingNoteId = null;
            saveAndRender();
          }
        });
      }

      // Checklist add item button
      const addRowBtn = card.querySelector('.checklist-edit-add-btn');
      if (addRowBtn) {
        addRowBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const itemsContainer = card.querySelector('.checklist-edit-items');
          if (itemsContainer) {
            const row = document.createElement('div');
            row.className = 'checklist-edit-row';
            row.innerHTML = `
              <input type="checkbox" class="checklist-edit-checkbox" aria-label="Mark done">
              <input type="text" class="checklist-edit-text" value="" placeholder="New item...">
              <button type="button" class="checklist-edit-del-btn" title="Remove item">✕</button>
            `;
            row.querySelector('.checklist-edit-del-btn').addEventListener('click', (ev) => {
              ev.stopPropagation();
              row.remove();
              updateCardCopyButton(card, note);
            });
            row.querySelector('.checklist-edit-text').addEventListener('keydown', (ev) => {
              if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                ev.preventDefault();
                saveCardEdit(id, card);
              } else if (ev.key === 'Escape') {
                ev.preventDefault();
                editingNoteId = null;
                render();
              }
            });
            itemsContainer.appendChild(row);
            const input = row.querySelector('.checklist-edit-text');
            if (input) input.focus();
          }
        });
      }

      // Checklist delete buttons
      card.querySelectorAll('.checklist-edit-del-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = btn.closest('.checklist-edit-row');
          if (row) {
            row.remove();
            updateCardCopyButton(card, note);
          }
        });
      });

      // Checklist inputs keyboard shortcuts
      card.querySelectorAll('.checklist-edit-text').forEach(input => {
        input.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            saveCardEdit(id, card);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            editingNoteId = null;
            render();
          }
        });
      });

      // Listen for text input while editing to dynamically update Copy button state
      if (isEditing) {
        card.addEventListener('input', () => {
          updateCardCopyButton(card, note);
        });
      }

      // Toggle note visibility on page
      card.querySelector('.btn-card-vis').addEventListener('click', (e) => {
        e.stopPropagation();
        const isFloatingToolbarEnabled = currentSettings.showFloatingButton !== false;
        if (!isFloatingToolbarEnabled && note.hidden) {
          showToast('Please enable the "On-Page Floating Toolbar" feature first to use this functionality.', 3200);
          return;
        }
        note.hidden = !note.hidden;
        note.updatedAt = Date.now();

        // If unhiding an individual note, ensure global notesVisible is enabled
        if (!note.hidden) {
          currentSettings.notesVisible = true;
          chrome.storage.local.set({ settings: currentSettings });
          updateHeaderVisIcon(true);
        }

        saveAndRender();

        // Send direct message to the active tab for instant response
        if (currentTab && currentTab.id) {
          chrome.tabs.sendMessage(currentTab.id, {
            action: 'SET_NOTE_VISIBILITY',
            noteId: note.id,
            hidden: note.hidden,
            notesVisible: currentSettings.notesVisible
          }).catch(() => { });
        }

        showToast(note.hidden ? 'Note hidden on page' : 'Note shown on page');
      });

      // Jump to note
      card.querySelector('.btn-card-jump').addEventListener('click', () => {
        jumpToNote(note);
      });

      // Copy content
      const copyBtn = card.querySelector('.btn-card-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (copyBtn.disabled) return;

          let textToCopy = '';
          if (editingNoteId === note.id) {
            if (note.isChecklist) {
              const rows = card.querySelectorAll('.checklist-edit-row');
              textToCopy = Array.from(rows).map(row => {
                const cb = row.querySelector('.checklist-edit-checkbox');
                const txt = row.querySelector('.checklist-edit-text');
                const val = txt ? txt.value.trim() : '';
                return val ? `${cb && cb.checked ? '[x]' : '[ ]'} ${val}` : '';
              }).filter(Boolean).join('\n');
            } else {
              const textarea = card.querySelector('.note-card-edit-textarea');
              textToCopy = textarea ? textarea.value.trim() : '';
            }
          } else {
            if (note.isChecklist) {
              textToCopy = (note.checklistItems || [])
                .filter(i => i && i.text && i.text.trim())
                .map(i => `${i.done ? '[x]' : '[ ]'} ${i.text.trim()}`)
                .join('\n');
            } else {
              textToCopy = (note.text || '').trim();
            }
          }

          if (!textToCopy) {
            updateCardCopyButton(card, note);
            return;
          }

          navigator.clipboard.writeText(textToCopy).then(() => {
            showToast('Copied to clipboard!');
          }).catch(() => {
            showToast('Failed to copy to clipboard.');
          });
        });
      }

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

  // Save Card Content Update in Workspace
  function saveCardEdit(id, card) {
    const note = allNotes.find(n => n.id === id);
    if (!note) return;

    if (note.isChecklist) {
      const rows = card.querySelectorAll('.checklist-edit-row');
      const newItems = [];
      rows.forEach((row, idx) => {
        const textInput = row.querySelector('.checklist-edit-text');
        const checkbox = row.querySelector('.checklist-edit-checkbox');
        const textVal = textInput ? textInput.value.trim() : '';
        if (textVal) {
          const oldItem = (note.checklistItems && note.checklistItems[idx]) || {};
          newItems.push({
            id: oldItem.id || ('item_' + Date.now() + '_' + idx),
            text: textVal,
            done: checkbox ? checkbox.checked : false
          });
        }
      });
      note.checklistItems = newItems;
      note.text = newItems.length > 0 ? newItems.map(i => i.text).join('\n') : '';
    } else {
      const textarea = card.querySelector('.note-card-edit-textarea');
      if (textarea) {
        note.text = textarea.value;
      }
    }

    note.updatedAt = Date.now();
    editingNoteId = null;
    saveAndRender();
    showToast('Note updated!');
  }

  function focusCardEditor(id) {
    setTimeout(() => {
      const card = notesGrid.querySelector(`[data-note-id="${id}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const textarea = card.querySelector('.note-card-edit-textarea');
      if (textarea) {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
      } else {
        const firstInput = card.querySelector('.checklist-edit-text');
        if (firstInput) firstInput.focus();
      }
    }, 60);
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
    if (!note.url && !note.domain) {
      showToast('No URL or domain associated with this note.');
      return;
    }
    chrome.runtime.sendMessage({
      action: 'FOCUS_NOTE',
      noteId: note.id,
      url: note.url,
      domain: note.domain || extractDomain(note.url)
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
      }).catch(() => { });
      if (currentTab && currentTab.id) {
        chrome.tabs.sendMessage(currentTab.id, {
          action: 'NOTES_UPDATED',
          notes: allNotes
        }).catch(() => { });
      }
    });
  }

  // Create note directly in workspace
  function createNoteInWorkspace(isHiddenOnPage = false) {
    // If a search query or checklist filter is active, reset so the new note is visible
    if (searchQuery) {
      searchQuery = '';
      searchInput.value = '';
      searchClearBtn.style.display = 'none';
    }
    if (activeFilter === 'checklists') {
      activeFilter = 'current-page';
      filterTabs.querySelectorAll('.chip').forEach(c => {
        const isActive = c.dataset.filter === 'current-page';
        c.classList.toggle('active', isActive);
        c.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }

    const noteColor = activeColorFilter !== 'all' ? activeColorFilter : (currentSettings.defaultColor || 'yellow');
    const noteId = 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    const newNote = {
      id: noteId,
      text: '',
      url: currentUrl || 'https://google.com',
      domain: currentDomain || 'Web',
      pageTitle: (currentTab && currentTab.title) || 'Sticky Note',
      color: noteColor,
      x: 100,
      y: 100,
      width: 250,
      height: 220,
      pinned: currentSettings.pinMode === 'screen',
      minimized: false,
      hidden: !!isHiddenOnPage,
      isChecklist: false,
      checklistItems: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    allNotes.unshift(newNote);
    editingNoteId = newNote.id;
    saveAndRender();
    focusCardEditor(newNote.id);
    showToast('New note created in workspace!');
  }

  // Create New Note from Header Button
  function createNewNoteOnCurrentPage() {
    const isFloatingToolbarEnabled = currentSettings.showFloatingButton !== false;

    if (isFloatingToolbarEnabled) {
      if (!currentTab || !currentTab.id) {
        // Fallback to workspace creation if current tab cannot be accessed
        createNoteInWorkspace(false);
        return;
      }

      // When floating toolbar is enabled: open note popup on current webpage as it does now
      chrome.tabs.sendMessage(currentTab.id, { action: 'CREATE_NOTE' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          // Content script might not run on chrome:// or webstore URLs; create in workspace without closing
          createNoteInWorkspace(false);
        } else {
          showToast('Added sticky note to page!');
          window.close();
        }
      });
    } else {
      // When floating toolbar is disabled: create directly in workspace without opening on-page popup
      createNoteInWorkspace(true);
    }
  }

  btnAddNote.addEventListener('click', createNewNoteOnCurrentPage);
  emptyAddBtn.addEventListener('click', createNewNoteOnCurrentPage);

  // Header visibility toggle
  if (btnHeaderVisibility) {
    btnHeaderVisibility.addEventListener('click', () => {
      const isFloatingToolbarEnabled = currentSettings.showFloatingButton !== false;
      if (!isFloatingToolbarEnabled && !currentSettings.notesVisible) {
        showToast('Please enable the "On-Page Floating Toolbar" feature first to use this functionality.', 3200);
        return;
      }
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
    const modalBody = settingsModal.querySelector('.modal-body');
    if (modalBody) {
      modalBody.scrollTop = 0;
    }
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
    chrome.storage.local.set({ settings: currentSettings }, () => {
      // Also notify active tab immediately
      if (currentTab && currentTab.id) {
        chrome.tabs.sendMessage(currentTab.id, {
          action: 'UPDATE_SETTINGS',
          settings: currentSettings
        }).catch(() => { });
      }
    });
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

  // Configure Shortcuts button (opens Chrome keyboard shortcuts manager)
  const btnConfigureShortcuts = document.getElementById('btn-configure-shortcuts');
  if (btnConfigureShortcuts) {
    btnConfigureShortcuts.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  // Update shortcut badges based on user's OS platform (Mac vs Windows/Linux)
  const isMacPlatform = (navigator.platform && navigator.platform.toUpperCase().indexOf('MAC') >= 0);
  if (isMacPlatform) {
    const wsBadge = document.getElementById('badge-shortcut-workspace');
    if (wsBadge) wsBadge.textContent = 'MacCtrl+Shift+W (⌃⇧W)';
    const newBadge = document.getElementById('badge-shortcut-new');
    if (newBadge) newBadge.textContent = 'MacCtrl+Shift+N (⌃⇧N)';
    const visBadge = document.getElementById('badge-shortcut-vis');
    if (visBadge) visBadge.textContent = 'MacCtrl+Shift+H (⌃⇧H)';
  }

  // Rate on Chrome Web Store button
  const btnRateStore = document.getElementById('btn-rate-store');
  if (btnRateStore) {
    btnRateStore.addEventListener('click', () => {
      const extId = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
        ? chrome.runtime.id
        : '';
      const url = extId
        ? `https://chromewebstore.google.com/detail/${extId}/reviews`
        : 'https://chromewebstore.google.com/category/extensions';
      chrome.tabs.create({ url });
    });
  }

  // Clear notes on current domain
  btnClearPageNotes.addEventListener('click', () => {
    if (!currentDomain) {
      showToast('No domain detected for current tab.');
      return;
    }
    if (!confirm(`Are you sure you want to delete all notes on ${currentDomain}?`)) return;
    allNotes = allNotes.filter(n => {
      const noteDomain = (n.domain || extractDomain(n.url) || '').toLowerCase();
      return noteDomain !== currentDomain;
    });
    saveAndRender();
    showToast(`Notes on ${currentDomain} deleted.`);
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

  // Export notes as JSON
  btnExportJson.addEventListener('click', () => {
    if (allNotes.length === 0) {
      showToast('No notes to export.');
      return;
    }
    const manifestVersion = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest().version
      : '1.1.0';
    const exportData = {
      version: manifestVersion || '1.1.0',
      exportedAt: new Date().toISOString(),
      notes: allNotes,
      settings: currentSettings
    };
    downloadBlob(JSON.stringify(exportData, null, 2), `NoteSticky_Notes_${Date.now()}.json`, 'application/json');
    showToast('Notes exported!');
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
  function showToast(message, duration = 2400) {
    if (popupToastTimeout) clearTimeout(popupToastTimeout);
    popupToast.textContent = message;
    popupToast.style.display = 'flex';
    popupToastTimeout = setTimeout(() => {
      popupToast.style.display = 'none';
    }, duration);
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
