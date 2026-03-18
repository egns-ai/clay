// pane-manager.js — orchestration layer for concurrent panes
//
// Creates/destroys panes, manages CSS Grid layout, handles pane focus.
// Each pane gets its own WS connection, module instances, and message processor.

import { iconHtml, refreshIcons } from './icons.js';
import { createRewindInstance } from './rewind.js';
import { createInputInstance } from './input.js';
import { createToolsInstance } from './tools.js';
import { createFileBrowserInstance } from './filebrowser.js';
import { createTerminalInstance } from './terminal.js';
import { createStickyNotesInstance } from './sticky-notes.js';
import { closeSidebar } from './sidebar.js';

var paneLayoutEl = null;
var panes = new Map(); // paneId -> pane object
var focusedPaneId = null;
var paneIdCounter = 0;
var globalCtx = null;

// --- Init ---

export function initPaneManager(ctx) {
  globalCtx = ctx;
  paneLayoutEl = document.getElementById("pane-layout");

  // Bootstrap primary pane from existing DOM
  var primaryEl = paneLayoutEl.querySelector('.pane[data-pane-id="primary"]');
  if (primaryEl) {
    var pane = {
      id: "primary",
      el: primaryEl,
      isPrimary: true,
      sessionId: null,
      sessionTitle: "New Session",
      agentStatus: "idle",
      modules: null, // primary uses singleton delegates from app.js
      ws: null,       // primary shares app.js's WS
      processor: null, // primary uses app.js's processMessage
    };
    panes.set("primary", pane);
    focusedPaneId = "primary";

    // Add click handler for focus
    primaryEl.addEventListener("mousedown", function () {
      setFocusedPane("primary");
    });
  }

  // Keyboard shortcuts for pane management
  document.addEventListener("keydown", function (e) {
    // Ctrl+\ — split focused pane vertically
    if (e.key === "\\" && e.ctrlKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      splitPane("horizontal");
      return;
    }
    // Ctrl+Shift+\ — split focused pane horizontally
    if (e.key === "\\" && e.ctrlKey && e.shiftKey && !e.metaKey) {
      e.preventDefault();
      splitPane("vertical");
      return;
    }
    // Ctrl+W — close focused pane (if >1 pane)
    if (e.key === "w" && e.ctrlKey && !e.shiftKey && !e.metaKey) {
      if (panes.size > 1 && focusedPaneId) {
        e.preventDefault();
        destroyPane(focusedPaneId);
        return;
      }
    }
    // Ctrl+1/2/3/4 — focus pane by index
    if (e.ctrlKey && !e.shiftKey && !e.metaKey) {
      var num = parseInt(e.key);
      if (num >= 1 && num <= 4) {
        var paneIds = Array.from(panes.keys());
        if (num <= paneIds.length) {
          e.preventDefault();
          setFocusedPane(paneIds[num - 1]);
        }
      }
    }
  });
}

// --- Create a new pane ---

export function createPane(opts) {
  opts = opts || {};
  var template = document.getElementById("pane-template");
  if (!template) return null;

  var paneId = "pane-" + (++paneIdCounter);
  var clone = template.content.cloneNode(true);
  var paneEl = clone.querySelector(".pane");
  paneEl.dataset.paneId = paneId;

  // Add pane header bar
  var headerBar = document.createElement("div");
  headerBar.className = "pane-header-bar";
  headerBar.innerHTML =
    '<span class="pane-header-status-dot"></span>' +
    '<span class="pane-header-title-text">' + (opts.sessionTitle || "New Session") + '</span>' +
    '<button class="pane-split-h-btn" title="Split right">' + iconHtml("columns") + '</button>' +
    '<button class="pane-split-v-btn" title="Split down">' + iconHtml("rows") + '</button>' +
    '<button class="pane-close-btn" title="Close pane">' + iconHtml("x") + '</button>';
  paneEl.insertBefore(headerBar, paneEl.firstChild);

  // Pane-scoped $ helper
  function $(cls) { return paneEl.querySelector(".pane-" + cls); }

  // Build ctx for per-pane modules
  var paneWs = null;
  var paneConnected = false;
  var paneProcessing = false;

  var paneCtx = {
    $: $,
    paneEl: paneEl,
    get ws() { return paneWs; },
    get connected() { return paneConnected; },
    get processing() { return paneProcessing; },
    get basePath() { return globalCtx.basePath; },
    messagesEl: $("messages"),
    inputEl: $("input"),
    sendBtn: $("send-btn"),
    slashMenu: $("slash-menu"),
    imagePreviewBar: $("image-preview-bar"),
    terminalContainerEl: $("terminal-container"),
    terminalBodyEl: $("terminal-body"),
    fileViewerEl: $("file-viewer"),
    // Cross-module callbacks — wired after all instances created
    closeSidebar: function () { closeSidebar(); },
    addSystemMessage: null,
    addUserMessage: null,
    scrollToBottom: null,
    setActivity: null,
    addToMessages: null,
    finalizeAssistantBlock: null,
    stopUrgentBlink: function () { /* per-pane: no-op for now */ },
    showImageModal: globalCtx.showImageModal,
    openFile: null,
    closeFileViewer: null,
    setRewindMode: null,
    isRewindMode: null,
    slashCommands: function () { return globalCtx.slashCommands(); },
    messageUuidMap: function () { return []; },
    hideSuggestionChips: function () {},
    setSendBtnMode: function () {},
    toggleUsagePanel: function () {},
    toggleStatusPanel: function () {},
    toggleContextPanel: function () {},
    resetContextData: function () {},
    isDmMode: function () { return false; },
    getDmKey: function () { return null; },
    handleDmSend: function () {},
    get turnCounter() { return 0; },
    getContextPercent: function () { return 0; },
  };

  // Create per-pane module instances
  var rewind = createRewindInstance(paneCtx);
  var input = createInputInstance(paneCtx);

  // Wire rewind callbacks for input
  paneCtx.setRewindMode = rewind.setRewindMode;
  paneCtx.isRewindMode = rewind.isRewindMode;

  var fileBrowser = createFileBrowserInstance(paneCtx);
  paneCtx.openFile = fileBrowser.openFile;
  paneCtx.closeFileViewer = fileBrowser.closeFileViewer;

  var tools = createToolsInstance(paneCtx);
  var terminal = createTerminalInstance(paneCtx);
  var stickyNotes = createStickyNotesInstance(paneCtx);

  // Append to layout
  paneLayoutEl.appendChild(paneEl);

  // Build pane object
  var pane = {
    id: paneId,
    el: paneEl,
    isPrimary: false,
    sessionId: opts.sessionId || null,
    sessionTitle: opts.sessionTitle || "New Session",
    agentStatus: "idle",
    modules: {
      rewind: rewind,
      input: input,
      tools: tools,
      fileBrowser: fileBrowser,
      terminal: terminal,
      stickyNotes: stickyNotes,
    },
    ws: null,
    processor: null,
    ctx: paneCtx,
    headerBar: headerBar,
  };

  panes.set(paneId, pane);

  // Set up pane header button handlers
  headerBar.querySelector(".pane-split-h-btn").addEventListener("click", function () {
    setFocusedPane(paneId);
    splitPane("horizontal");
  });
  headerBar.querySelector(".pane-split-v-btn").addEventListener("click", function () {
    setFocusedPane(paneId);
    splitPane("vertical");
  });
  headerBar.querySelector(".pane-close-btn").addEventListener("click", function () {
    destroyPane(paneId);
  });

  // Focus on click
  paneEl.addEventListener("mousedown", function () {
    setFocusedPane(paneId);
  });

  // Update layout
  updateGridLayout();
  refreshIcons();

  return pane;
}

// --- Destroy a pane ---

export function destroyPane(paneId) {
  var pane = panes.get(paneId);
  if (!pane) return;

  // Don't destroy the last pane
  if (panes.size <= 1) return;

  // Close WS
  if (pane.ws) {
    pane.ws.onclose = null;
    pane.ws.close();
    pane.ws = null;
  }

  // Cleanup module instances
  if (pane.modules) {
    if (pane.modules.terminal) pane.modules.terminal.resetTerminals();
    // Timers and observers cleaned up by GC when closures are released
  }

  // Remove DOM
  if (pane.el && pane.el.parentNode) {
    pane.el.parentNode.removeChild(pane.el);
  }

  panes.delete(paneId);

  // If focused pane was destroyed, focus the first remaining
  if (focusedPaneId === paneId) {
    var first = panes.keys().next().value;
    setFocusedPane(first);
  }

  updateGridLayout();
}

// --- Split focused pane ---

export function splitPane(direction) {
  if (panes.size >= 4) return; // max 4 panes

  // Can't split on mobile
  if (window.innerWidth <= 768) return;

  var newPane = createPane({
    sessionTitle: "New Session",
  });

  if (newPane) {
    setFocusedPane(newPane.id);
  }

  return newPane;
}

// --- Focus management ---

export function setFocusedPane(paneId) {
  if (!panes.has(paneId)) return;

  // Remove focus from all
  for (var p of panes.values()) {
    p.el.classList.remove("pane-focused");
  }

  // Set focused
  focusedPaneId = paneId;
  var pane = panes.get(paneId);
  if (pane) {
    pane.el.classList.add("pane-focused");
  }
}

export function getFocusedPaneId() {
  return focusedPaneId;
}

export function getFocusedPane() {
  return panes.get(focusedPaneId) || null;
}

// --- Grid layout ---

function updateGridLayout() {
  var count = panes.size;
  // Remove all layout classes
  paneLayoutEl.classList.remove("pane-layout-1", "pane-layout-2h", "pane-layout-2v", "pane-layout-4");

  if (count <= 1) {
    paneLayoutEl.classList.add("pane-layout-1");
  } else if (count === 2) {
    paneLayoutEl.classList.add("pane-layout-2h");
  } else {
    paneLayoutEl.classList.add("pane-layout-4");
  }
}

export function applyGridLayout(layoutClass) {
  paneLayoutEl.classList.remove("pane-layout-1", "pane-layout-2h", "pane-layout-2v", "pane-layout-4");
  paneLayoutEl.classList.add(layoutClass);
}

// --- Query ---

export function getPanes() {
  return panes;
}

export function getPaneCount() {
  return panes.size;
}

export function getAttentionPanes() {
  var result = [];
  for (var p of panes.values()) {
    if (p.agentStatus === "waiting_permission" || p.agentStatus === "waiting_input") {
      result.push(p);
    }
  }
  return result;
}

// --- Update pane header ---

export function updatePaneHeader(paneId, title, status) {
  var pane = panes.get(paneId);
  if (!pane || !pane.headerBar) return;

  if (title !== undefined) {
    pane.sessionTitle = title;
    var titleEl = pane.headerBar.querySelector(".pane-header-title-text");
    if (titleEl) titleEl.textContent = title;
  }

  if (status !== undefined) {
    pane.agentStatus = status;
    var dot = pane.headerBar.querySelector(".pane-header-status-dot");
    if (dot) {
      dot.className = "pane-header-status-dot";
      if (status !== "idle") dot.classList.add(status);
    }
  }
}
