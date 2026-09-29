# 📌 NoteSticky - Webpage & Dashboard Sticky Notes (Chrome Extension)

A powerful, aesthetic, modern **Google Chrome Extension (Manifest V3)** that allows you to pin, drag, and organize vibrant sticky notes directly onto any webpage, complete with an interactive dashboard, checklist mode, real-time search, and local persistence.

---

## ✨ Features

- **🌐 On-Page Sticky Notes**:
  - Pin sticky notes anywhere on any webpage or domain.
  - **Shadow DOM Isolation**: Zero CSS conflicts. The host website's styles will never break your notes, and your notes will never interfere with the website.
  - **Buttery-Smooth Dragging & Resizing**: Drag by header handle, resize from bottom-right corner with pointer capture.
  - **7 Vibrant Aesthetic Color Themes**:
    - 🟡 Canary Yellow
    - 🟢 Fresh Mint
    - 🔴 Blush Coral
    - 🟣 Dream Lavender
    - 🔵 Ocean Sky
    - 🟠 Sunset Peach
    - ⚪ Dark Slate
  - **Interactive Checklist / Todo Mode**: Convert any note into a clickable checklist with checkboxes, strike-through, and progress tracking.
  - **👁️ Independent Hide / Show for Each Sticky Note**:
    - Click **👁️** on any sticky note header to hide *only that specific sticky note*.
    - It transforms into an unobtrusive mini pill (`📌 Title 👁️`) right at its position without hiding any other notes.
    - Click **👁️** on the mini pill anytime to expand and show that specific note again!
    - In the popup dashboard, toggle visibility independently for any note with its own eye icon.
    - Floating Quick Toolbar remains completely untouched and functions normally.
  - **Pinning Modes**:
    - *Page Mode*: Scrolls naturally with the webpage content.
    - *Screen Mode*: Stays fixed in the viewport like a floating HUD.
  - **Minimize to Tab**: Collapse notes into a compact mini bar to keep your workspace tidy.
  - **Undo Delete Toast**: Accidentally closed a note? Instant 4-second Undo toast restores it.

- **🎛️ Popup Dashboard**:
  - Accessible directly from your Chrome extension toolbar.
  - **Smart Filtering**: Filter by "This Page", "All Notes", "Checklists", or by color.
  - **Live Search**: Instant instant search across note content, checklists, domains, and page titles.
  - **🚀 Jump to Note**: Clicking "Jump to Page" switches to that tab (or opens the URL) and smoothly scrolls to and highlights the sticky note with a pulsing gold aura!
  - **📋 Quick Copy**: 1-click copy note or checklist content to clipboard.
  - **📥 Export / 📤 Backup**: Export all notes as clean Markdown (`.md`) or full JSON backup (`.json`), with 1-click JSON restore.
  - **🌙 Dark & Light Themes**: Auto-detects system theme or manually toggle dark mode.

- **⌨️ Shortcuts & Context Menus**:
  - Right-click anywhere on any page $\rightarrow$ **"📌 Add Sticky Note here"**.
  - Highlight any text, right click $\rightarrow$ **"📝 Create Sticky Note from selection"**.
  - Default keyboard shortcut: <kbd>Alt+Shift+N</kbd> (Mac: <kbd>Ctrl+Shift+N</kbd>) to create a new note.
  - Visibility shortcut: <kbd>Alt+Shift+H</kbd> to toggle all notes on/off.
  - Extension icon badge displays live count of notes on the current active tab.

---

## 🚀 How to Install & Load in Google Chrome

Loading the extension takes less than 30 seconds:

1. Open **Google Chrome**.
2. In the URL address bar, navigate to:
   ```text
   chrome://extensions
   ```
3. In the top right corner of the Extensions page, enable **"Developer mode"** (toggle switch).
4. Click the **"Load unpacked"** button in the top left.
5. Select this project folder:
   ```text
   /Users/bugsbunny/Documents/personalProject/sticky notes
   ```
6. That's it! 🎉 You will see **NoteSticky - Webpage & Dashboard Sticky Notes** appear in your extension list.
7. Click the **Puzzle icon** (Extensions menu) in the top-right of Chrome and pin **NoteSticky** for quick access.

---

## 🧪 Testing the Extension

1. After loading the unpacked extension, open the included test page in Chrome:
   - Double-click `demo.html` or drag it into Chrome (or open `file:///Users/bugsbunny/Documents/personalProject/sticky%20notes/demo.html`).
2. You will see the floating quick-action pill in the bottom right corner.
3. Click **"➕ New Note"**, drag it around, change colors, switch to checklist mode, and open the popup dashboard!

---

## 📁 Project Architecture

```text
sticky notes/
├── manifest.json            # Chrome Extension Manifest V3 configuration
├── demo.html                # Interactive test and demonstration webpage
├── README.md                # Documentation and guide
├── icons/
│   ├── icon16.png           # 16x16 extension icon
│   ├── icon48.png           # 48x48 extension icon
│   ├── icon128.png          # 128x128 extension icon
│   └── icon.svg             # Scalable vector master icon
├── popup/
│   ├── popup.html           # Dashboard interface
│   ├── popup.css            # Dark/light styling, glassmorphism, responsive cards
│   └── popup.js             # Search, filter, jump-to-page, import/export logic
├── content/
│   ├── content.js           # Injected on-page script running in Shadow DOM
│   └── content.css          # Encapsulated styles for sticky notes & floating toolbar
└── background/
    └── background.js        # Service worker (context menus, shortcuts, badge counter)
```

---

## 🛠️ How It Works (Technical Overview)

1. **Manifest V3 Service Worker**:
   - `background.js` listens to tab changes and queries `chrome.storage.local` to show an active note count badge directly on the Chrome toolbar icon.
   - Handles the browser context menus and keyboard shortcut triggers.

2. **Shadow DOM Encapsulation**:
   - `content.js` creates a root container `#notesticky-root` and attaches an open Shadow DOM (`host.attachShadow({ mode: 'open' })`).
   - All sticky note DOM elements and `content.css` are enclosed inside the Shadow Root. This guarantees that host website styles (such as Tailwind resets or aggressive CSS rules) will never conflict with the sticky notes.

3. **Storage & State Sync**:
   - All note records are stored in `chrome.storage.local`.
   - Both the content script and popup dashboard listen to `chrome.storage.onChanged`, ensuring instantaneous, zero-latency two-way updates between what you edit on a webpage and what appears in your popup dashboard.
