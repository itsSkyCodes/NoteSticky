// NoteSticky - Background Service Worker (Manifest V3)

// Initialize extension on install
chrome.runtime.onInstalled.addListener(() => {
  // Set default settings if not already present
  chrome.storage.local.get(['settings', 'notes'], (res) => {
    const toSet = {};
    if (!res.settings) {
      toSet.settings = {
        notesVisible: true,
        defaultColor: 'yellow',
        theme: 'system',
        showFloatingButton: true,
        pinMode: 'page', // 'page' (scrolls with page) or 'screen' (fixed in viewport)
        soundEnabled: true,
        fabMinimized: false
      };
    }
    if (!res.notes) {
      toSet.notes = [];
    }
    if (Object.keys(toSet).length > 0) {
      chrome.storage.local.set(toSet);
    }
  });

  // Create Context Menus
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "add-sticky-page",
      title: "📌 Add Sticky Note here",
      contexts: ["page"]
    });

    chrome.contextMenus.create({
      id: "add-sticky-selection",
      title: "📝 Create Sticky Note from \"%s\"",
      contexts: ["selection"]
    });

    chrome.contextMenus.create({
      id: "toggle-page-notes",
      title: "👁️ Toggle Notes Visibility",
      contexts: ["action", "page"]
    });
  });
});

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === "add-sticky-page") {
    // Pass null for x and y so content script calculates coordinates based on current scroll position
    chrome.tabs.sendMessage(tab.id, {
      action: "CREATE_NOTE",
      text: "",
      x: null,
      y: null
    }).catch(() => {
      // Content script might not be injected on special pages (chrome://, etc.)
    });
  } else if (info.menuItemId === "add-sticky-selection") {
    chrome.tabs.sendMessage(tab.id, {
      action: "CREATE_NOTE",
      text: info.selectionText || "",
      x: null,
      y: null
    }).catch(() => {});
  } else if (info.menuItemId === "toggle-page-notes") {
    chrome.tabs.sendMessage(tab.id, {
      action: "TOGGLE_VISIBILITY"
    }).catch(() => {});
  }
});

// Handle keyboard shortcuts defined in manifest commands
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0] || !tabs[0].id) return;
    const tabId = tabs[0].id;

    if (command === "new-sticky-note") {
      chrome.tabs.sendMessage(tabId, { action: "CREATE_NOTE" }).catch(() => {});
    } else if (command === "toggle-notes-visibility") {
      chrome.tabs.sendMessage(tabId, { action: "TOGGLE_VISIBILITY" }).catch(() => {});
    }
  });
});

// Update extension icon badge count for current URL
function updateBadgeForTab(tabId, url) {
  if (!tabId || !url || url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://')) {
    try {
      chrome.action.setBadgeText({ tabId, text: '' });
    } catch (_) {}
    return;
  }

  chrome.storage.local.get(['notes'], (res) => {
    if (chrome.runtime.lastError) return;
    const notes = res.notes || [];
    // Match current page URL (ignoring hash)
    const cleanUrl = url.split('#')[0];
    const pageNotes = notes.filter(n => n.url && n.url.split('#')[0] === cleanUrl);
    const count = pageNotes.length;

    try {
      if (count > 0) {
        chrome.action.setBadgeText({ tabId, text: count.toString() });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#F59E0B' }); // Vibrant Amber
      } else {
        chrome.action.setBadgeText({ tabId, text: '' });
      }
    } catch (_) {
      // Tab may have closed before callback returned
    }
  });
}

// Tab listeners for badge update
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    updateBadgeForTab(tab.id, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url) {
    updateBadgeForTab(tabId, tab.url);
  }
});

// Message listener from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "UPDATE_BADGE") {
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    const url = sender.tab ? sender.tab.url : request.url;
    if (tabId && url) {
      updateBadgeForTab(tabId, url);
      sendResponse({ success: true });
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id && tabs[0].url) {
          updateBadgeForTab(tabs[0].id, tabs[0].url);
        }
        sendResponse({ success: true });
      });
      return true;
    }
    return true;
  }

  if (request.action === "FOCUS_NOTE") {
    // Navigate or switch to the tab containing the note, and tell it to highlight
    const { noteId, url } = request;
    chrome.tabs.query({}, (tabs) => {
      const cleanTarget = url.split('#')[0];
      const existingTab = tabs.find(t => t.url && t.url.split('#')[0] === cleanTarget);

      if (existingTab) {
        chrome.tabs.update(existingTab.id, { active: true }, () => {
          chrome.windows.update(existingTab.windowId, { focused: true });
          setTimeout(() => {
            chrome.tabs.sendMessage(existingTab.id, { action: "HIGHLIGHT_NOTE", noteId }).catch(() => {});
          }, 300);
        });
      } else {
        chrome.tabs.create({ url }, (newTab) => {
          // Listen once for page complete to highlight
          const listener = (tabId, info) => {
            if (tabId === newTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(() => {
                chrome.tabs.sendMessage(newTab.id, { action: "HIGHLIGHT_NOTE", noteId }).catch(() => {});
              }, 600);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }
    });
    sendResponse({ success: true });
    return true;
  }
});
