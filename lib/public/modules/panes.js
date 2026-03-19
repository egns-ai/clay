// --- Tiling Panes Module (zellij-style split layout) ---
// Binary split tree drives layout. Each leaf is a pane showing a session;
// each internal node is a split (horizontal or vertical) with a ratio.
// Each pane is a self-contained object (from createPaneState) — no context swapping.

import { createPaneState } from './pane-state.js';

var ctx;
var paneIdCounter = 0;
var treeRoot = null; // { type: "leaf", paneId, sessionId } | { type: "split", direction, ratio, children: [a, b] }
var paneStates = {}; // paneId -> pane object (from createPaneState)
var activePaneId = null;
var isMobilePanes = false;
var mobileMediaQuery = null;
var paneArea = null;

// --- Exports ---
export function initPanes(_ctx) {
  ctx = _ctx;
  paneArea = document.getElementById("pane-area");
  mobileMediaQuery = window.matchMedia("(max-width: 1023px)");
  isMobilePanes = mobileMediaQuery.matches;
  mobileMediaQuery.addEventListener("change", function (e) {
    var wasMobile = isMobilePanes;
    isMobilePanes = e.matches;
    if (getPaneCount() > 1 && wasMobile !== isMobilePanes) {
      renderPaneTree();
    }
  });

  // Set up #app as initial drop target for creating first split
  var appEl = document.getElementById("app");
  if (appEl) {
    setupAppDropTarget(appEl);
  }
}

export function getPaneCount() {
  if (!treeRoot) return 0;
  return countLeaves(treeRoot);
}

export function getActivePaneId() {
  return activePaneId;
}

export function getPaneForSession(sessionId) {
  var result = null;
  forEachLeaf(treeRoot, function (leaf) {
    if (leaf.sessionId === sessionId && !result) result = leaf.paneId;
  });
  return result;
}

export function getPaneState(paneId) {
  return paneStates[paneId] || null;
}

export function resolvePane(msg) {
  if (treeRoot && msg.sessionId != null) {
    var paneId = getPaneForSession(msg.sessionId);
    if (paneId && paneStates[paneId]) return paneStates[paneId];
  }
  return null; // single-pane mode — caller uses defaultPane
}

export function setActivePane(paneId) {
  if (activePaneId === paneId) return;
  var oldId = activePaneId;
  activePaneId = paneId;
  // Update visual highlight
  if (paneArea) {
    var oldEl = oldId ? paneArea.querySelector('.pane-container[data-pane-id="' + oldId + '"]') : null;
    if (oldEl) oldEl.classList.remove("pane-active");
    var newEl = paneId ? paneArea.querySelector('.pane-container[data-pane-id="' + paneId + '"]') : null;
    if (newEl) newEl.classList.add("pane-active");
  }
  // Update mobile tab bar active state
  if (isMobilePanes) {
    var tabs = paneArea ? paneArea.querySelectorAll(".pane-tab") : [];
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("pane-tab-active", tabs[i].dataset.paneId === paneId);
    }
  }
}

// savePaneContext / activatePaneContext removed — pane-as-object architecture
// eliminates context swapping. Each pane object owns its state directly.

// Create initial split from single-pane mode
export function splitPane(existingPaneId, direction, newSessionId) {
  if (!treeRoot) {
    // First pane: convert existing #app session into a pane
    var firstPaneId = "pane-" + (++paneIdCounter);
    treeRoot = { type: "leaf", paneId: firstPaneId, sessionId: ctx.getActiveSessionId() };
    initPaneState(firstPaneId, ctx.getActiveSessionId());
    activePaneId = firstPaneId;
    existingPaneId = firstPaneId;
  }

  var newPaneId = "pane-" + (++paneIdCounter);
  initPaneState(newPaneId, newSessionId);

  // Find the leaf node in the tree and replace it with a split
  var newLeaf = { type: "leaf", paneId: newPaneId, sessionId: newSessionId };
  replaceInTree(existingPaneId, function (oldLeaf) {
    return {
      type: "split",
      direction: direction,
      ratio: 0.5,
      children: [oldLeaf, newLeaf],
    };
  });

  // Send watch_session to server for both sessions
  if (ctx.ws && ctx.ws.readyState === 1) {
    // Watch the existing session too (server already has it as primary, but add to Set)
    var existingState = paneStates[existingPaneId];
    if (existingState) {
      ctx.ws.send(JSON.stringify({ type: "watch_session", sessionId: existingState.sessionId }));
    }
    ctx.ws.send(JSON.stringify({ type: "watch_session", sessionId: newSessionId }));
  }

  // Show pane area, hide #app
  showPaneArea();
  renderPaneTree();
  setActivePane(newPaneId);

  // Request history for BOTH panes (server tags with sessionId, resolvePane routes correctly)
  if (ctx.ws && ctx.ws.readyState === 1) {
    var existState = paneStates[existingPaneId];
    if (existState) {
      ctx.ws.send(JSON.stringify({ type: "switch_session", id: existState.sessionId, paneId: existingPaneId }));
    }
    ctx.ws.send(JSON.stringify({ type: "switch_session", id: newSessionId, paneId: newPaneId }));
  }
}

export function replacePaneSession(paneId, newSessionId) {
  var state = paneStates[paneId];
  if (!state) return;
  var oldSessionId = state.sessionId;

  // Unwatch old session
  if (ctx.ws && ctx.ws.readyState === 1) {
    ctx.ws.send(JSON.stringify({ type: "unwatch_session", sessionId: oldSessionId }));
    ctx.ws.send(JSON.stringify({ type: "watch_session", sessionId: newSessionId }));
  }

  // Update tree
  forEachLeaf(treeRoot, function (leaf) {
    if (leaf.paneId === paneId) {
      leaf.sessionId = newSessionId;
    }
  });

  // Reset pane state (cancel any in-flight timers)
  if (state.streamDrainTimer) cancelAnimationFrame(state.streamDrainTimer);
  if (state.highlightTimer) clearTimeout(state.highlightTimer);
  state.sessionId = newSessionId;
  state.messagesEl.innerHTML = "";
  state.currentMsgEl = null;
  state.currentFullText = "";
  state.streamBuffer = "";
  state.streamDrainTimer = null;
  state.highlightTimer = null;
  state.processing = false;
  state.turnCounter = 0;
  state.messageUuidMap = [];
  state.historyFrom = 0;
  state.historyTotal = 0;
  state.replayingHistory = false;
  state.toolState = null;

  // Update header
  var container = paneArea.querySelector('.pane-container[data-pane-id="' + paneId + '"]');
  if (container) {
    var titleEl = container.querySelector(".pane-header-title");
    if (titleEl) titleEl.textContent = getSessionTitle(newSessionId);
  }

  // Request history for new session
  if (ctx.ws && ctx.ws.readyState === 1) {
    ctx.ws.send(JSON.stringify({ type: "switch_session", id: newSessionId, paneId: paneId }));
  }
}

export function closePane(paneId) {
  if (!treeRoot || getPaneCount() <= 1) {
    // Last pane: go back to single-pane mode
    var survivingPane = paneStates[paneId];
    if (survivingPane) {
      if (survivingPane.streamDrainTimer) cancelAnimationFrame(survivingPane.streamDrainTimer);
      if (survivingPane.highlightTimer) clearTimeout(survivingPane.highlightTimer);
    }
    hidePaneArea();
    treeRoot = null;
    paneStates = {};
    activePaneId = null;
    // Request fresh history — server replays into defaultPane via normal single-pane flow
    if (survivingPane && ctx.ws && ctx.ws.readyState === 1) {
      ctx.ws.send(JSON.stringify({ type: "switch_session", id: survivingPane.sessionId }));
    }
    return;
  }

  var state = paneStates[paneId];
  if (state) {
    // Cancel any in-flight timers on the closing pane
    if (state.streamDrainTimer) cancelAnimationFrame(state.streamDrainTimer);
    if (state.highlightTimer) clearTimeout(state.highlightTimer);
    // Unwatch session
    if (ctx.ws && ctx.ws.readyState === 1) {
      ctx.ws.send(JSON.stringify({ type: "unwatch_session", sessionId: state.sessionId }));
    }
  }

  // Remove from tree: find parent split, promote sibling
  removeLeafFromTree(paneId);
  delete paneStates[paneId];

  // If only one pane left, go back to single mode
  if (getPaneCount() === 1) {
    var lastLeaf = getFirstLeaf(treeRoot);
    var lastPane = paneStates[lastLeaf.paneId];
    if (lastPane) {
      if (lastPane.streamDrainTimer) cancelAnimationFrame(lastPane.streamDrainTimer);
      if (lastPane.highlightTimer) clearTimeout(lastPane.highlightTimer);
    }
    hidePaneArea();
    treeRoot = null;
    paneStates = {};
    activePaneId = null;
    // Request fresh history — server replays into defaultPane via normal single-pane flow
    if (lastPane && ctx.ws && ctx.ws.readyState === 1) {
      ctx.ws.send(JSON.stringify({ type: "switch_session", id: lastPane.sessionId }));
    }
    return;
  }

  // Switch to another pane
  var firstLeaf = getFirstLeaf(treeRoot);
  if (firstLeaf) {
    setActivePane(firstLeaf.paneId);
  }
  renderPaneTree();
}

export function createPaneDOM(paneId, sessionId) {
  var container = document.createElement("div");
  container.className = "pane-container";
  container.dataset.paneId = paneId;
  if (paneId === activePaneId) container.classList.add("pane-active");

  // Header
  var header = document.createElement("div");
  header.className = "pane-header";

  var title = document.createElement("span");
  title.className = "pane-header-title";
  title.textContent = getSessionTitle(sessionId);
  header.appendChild(title);

  var btnGroup = document.createElement("span");
  btnGroup.className = "pane-header-btns";

  var splitHBtn = document.createElement("button");
  splitHBtn.className = "pane-header-btn";
  splitHBtn.title = "Split right";
  splitHBtn.innerHTML = "&#x2503;"; // vertical bar
  splitHBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    // Open a prompt or just split with a new session? For now, just mark for drop
  });
  btnGroup.appendChild(splitHBtn);

  var splitVBtn = document.createElement("button");
  splitVBtn.className = "pane-header-btn";
  splitVBtn.title = "Split down";
  splitVBtn.innerHTML = "&#x2501;"; // horizontal bar
  btnGroup.appendChild(splitVBtn);

  var closeBtn = document.createElement("button");
  closeBtn.className = "pane-header-btn pane-close-btn";
  closeBtn.title = "Close pane";
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    closePane(paneId);
  });
  btnGroup.appendChild(closeBtn);

  header.appendChild(btnGroup);
  container.appendChild(header);

  // Messages area
  var messagesEl = document.createElement("div");
  messagesEl.className = "pane-messages";
  container.appendChild(messagesEl);

  // Input area
  var inputArea = document.createElement("div");
  inputArea.className = "pane-input-area";

  var inputRow = document.createElement("div");
  inputRow.className = "pane-input-row";

  var textarea = document.createElement("textarea");
  textarea.className = "pane-input";
  textarea.rows = 1;
  textarea.placeholder = "Message Claude Code...";
  textarea.setAttribute("enterkeyhint", "send");
  textarea.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      // Activate this pane and send
      setActivePane(paneId);
      if (ctx.sendMessage) ctx.sendMessage();
    }
  });
  textarea.addEventListener("focus", function () {
    setActivePane(paneId);
  });
  inputRow.appendChild(textarea);

  var sendBtn = document.createElement("button");
  sendBtn.className = "pane-send-btn";
  sendBtn.innerHTML = "&#x2191;"; // up arrow
  sendBtn.addEventListener("click", function () {
    setActivePane(paneId);
    if (ctx.sendMessage) ctx.sendMessage();
  });
  inputRow.appendChild(sendBtn);

  inputArea.appendChild(inputRow);
  container.appendChild(inputArea);

  // Click to activate
  container.addEventListener("mousedown", function () {
    if (activePaneId !== paneId) {
      setActivePane(paneId);
    }
  });

  // Drag-and-drop target
  setupPaneDropTarget(container, paneId);

  // Store DOM refs in pane state
  var ps = paneStates[paneId];
  if (ps) {
    ps.messagesEl = messagesEl;
    ps.inputEl = textarea;
    ps.containerEl = container;
  }

  return container;
}

export function renderPaneTree() {
  if (!paneArea || !treeRoot) return;
  paneArea.innerHTML = "";

  if (isMobilePanes) {
    renderMobileTabBar();
    return;
  }

  var rootEl = renderNode(treeRoot);
  paneArea.appendChild(rootEl);
}

export function getAllPaneSessionIds() {
  var ids = [];
  forEachLeaf(treeRoot, function (leaf) {
    ids.push(leaf.sessionId);
  });
  return ids;
}

export function updatePaneTitle(sessionId, title) {
  forEachLeaf(treeRoot, function (leaf) {
    if (leaf.sessionId === sessionId) {
      var container = paneArea ? paneArea.querySelector('.pane-container[data-pane-id="' + leaf.paneId + '"]') : null;
      if (container) {
        var titleEl = container.querySelector(".pane-header-title");
        if (titleEl) titleEl.textContent = title;
      }
    }
  });
  // Update mobile tabs too
  if (isMobilePanes && paneArea) {
    var tabs = paneArea.querySelectorAll(".pane-tab");
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].dataset.sessionId === String(sessionId)) {
        var span = tabs[i].querySelector(".pane-tab-title");
        if (span) span.textContent = title;
      }
    }
  }
}

// --- Internal helpers ---

function initPaneState(paneId, sessionId) {
  paneStates[paneId] = createPaneState({
    paneId: paneId,
    sessionId: sessionId,
    renderMarkdown: ctx.renderMarkdown,
    highlightCodeBlocks: ctx.highlightCodeBlocks,
    renderMermaidBlocks: ctx.renderMermaidBlocks,
    addCopyHandler: ctx.addCopyHandler,
    closeToolGroup: ctx.closeToolGroup,
    newMsgBtn: null, // pane has its own scroll area, no global new-msg-btn
  });
}

function setupAppDropTarget(appEl) {
  var overlay = null;

  appEl.addEventListener("dragover", function (e) {
    // Only handle when in single-pane mode
    if (getPaneCount() > 0) return;
    var types = e.dataTransfer.types;
    var hasSession = false;
    for (var i = 0; i < types.length; i++) {
      if (types[i] === "text/x-clay-session") { hasSession = true; break; }
    }
    if (!hasSession) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "pane-drop-overlay";
      appEl.style.position = "relative";
      appEl.appendChild(overlay);
    }

    var rect = appEl.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    overlay.className = "pane-drop-overlay";
    if (x < 0.5) {
      overlay.classList.add("pane-drop-left");
    } else {
      overlay.classList.add("pane-drop-right");
    }
  });

  appEl.addEventListener("dragleave", function (e) {
    if (!appEl.contains(e.relatedTarget)) {
      if (overlay) { overlay.remove(); overlay = null; }
    }
  });

  appEl.addEventListener("drop", function (e) {
    if (getPaneCount() > 0) return;
    e.preventDefault();
    var sessionId = parseInt(e.dataTransfer.getData("text/x-clay-session"), 10);
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.classList.remove("pane-drag-active");

    if (!sessionId || isNaN(sessionId)) return;

    // Don't split if dropping the same session that's currently active
    var currentSessionId = ctx.getActiveSessionId();
    if (sessionId === currentSessionId) return;

    // Determine split direction from drop position
    var rect = appEl.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = (e.clientY - rect.top) / rect.height;
    var direction = Math.abs(x - 0.5) > Math.abs(y - 0.5) ? "horizontal" : "vertical";

    // Create first split: this initializes the tree from single-pane mode
    splitPane(null, direction, sessionId);
  });
}

function countLeaves(node) {
  if (!node) return 0;
  if (node.type === "leaf") return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

function forEachLeaf(node, fn) {
  if (!node) return;
  if (node.type === "leaf") { fn(node); return; }
  forEachLeaf(node.children[0], fn);
  forEachLeaf(node.children[1], fn);
}

function getFirstLeaf(node) {
  if (!node) return null;
  if (node.type === "leaf") return node;
  return getFirstLeaf(node.children[0]);
}

function replaceInTree(paneId, replacer) {
  if (!treeRoot) return;
  if (treeRoot.type === "leaf" && treeRoot.paneId === paneId) {
    treeRoot = replacer(treeRoot);
    return;
  }
  replaceInNode(treeRoot, paneId, replacer);
}

function replaceInNode(node, paneId, replacer) {
  if (node.type !== "split") return;
  for (var i = 0; i < 2; i++) {
    var child = node.children[i];
    if (child.type === "leaf" && child.paneId === paneId) {
      node.children[i] = replacer(child);
      return;
    }
    if (child.type === "split") {
      replaceInNode(child, paneId, replacer);
    }
  }
}

function removeLeafFromTree(paneId) {
  if (!treeRoot) return;
  if (treeRoot.type === "leaf") {
    if (treeRoot.paneId === paneId) treeRoot = null;
    return;
  }
  removeLeafFromNode(null, -1, treeRoot, paneId);
}

function removeLeafFromNode(parent, childIndex, node, paneId) {
  if (node.type !== "split") return;
  for (var i = 0; i < 2; i++) {
    var child = node.children[i];
    if (child.type === "leaf" && child.paneId === paneId) {
      // Promote sibling to parent's position
      var sibling = node.children[1 - i];
      if (parent) {
        parent.children[childIndex] = sibling;
      } else {
        treeRoot = sibling;
      }
      return;
    }
    if (child.type === "split") {
      removeLeafFromNode(node, i, child, paneId);
    }
  }
}

function renderNode(node) {
  if (node.type === "leaf") {
    return createPaneDOM(node.paneId, node.sessionId);
  }

  var splitContainer = document.createElement("div");
  splitContainer.className = "pane-split pane-split-" + node.direction;

  var child0El = renderNode(node.children[0]);
  var child1El = renderNode(node.children[1]);

  // Apply ratio via flex
  var ratio = node.ratio;
  if (node.direction === "horizontal") {
    child0El.style.width = "calc(" + (ratio * 100) + "% - 2px)";
    child1El.style.width = "calc(" + ((1 - ratio) * 100) + "% - 2px)";
    child0El.style.height = "100%";
    child1El.style.height = "100%";
  } else {
    child0El.style.height = "calc(" + (ratio * 100) + "% - 2px)";
    child1El.style.height = "calc(" + ((1 - ratio) * 100) + "% - 2px)";
    child0El.style.width = "100%";
    child1El.style.width = "100%";
  }

  splitContainer.appendChild(child0El);

  // Resize handle
  var handle = document.createElement("div");
  handle.className = "pane-resize-handle pane-resize-" + node.direction;
  setupResizeHandle(handle, node, splitContainer);
  splitContainer.appendChild(handle);

  splitContainer.appendChild(child1El);

  return splitContainer;
}

function setupResizeHandle(handle, splitNode, container) {
  var dragging = false;
  var startPos = 0;
  var startRatio = 0;

  function onMouseDown(e) {
    e.preventDefault();
    dragging = true;
    startPos = splitNode.direction === "horizontal" ? e.clientX : e.clientY;
    startRatio = splitNode.ratio;
    document.body.classList.add("pane-resizing");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    if (!dragging) return;
    var rect = container.getBoundingClientRect();
    var totalSize = splitNode.direction === "horizontal" ? rect.width : rect.height;
    if (totalSize === 0) return;
    var currentPos = splitNode.direction === "horizontal" ? e.clientX : e.clientY;
    var delta = currentPos - startPos;
    var newRatio = startRatio + (delta / totalSize);
    newRatio = Math.max(0.15, Math.min(0.85, newRatio));
    splitNode.ratio = newRatio;

    // Update children sizes
    var children = container.children;
    var child0 = children[0];
    var child2 = children[2]; // skip handle at index 1
    if (splitNode.direction === "horizontal") {
      child0.style.width = "calc(" + (newRatio * 100) + "% - 2px)";
      child2.style.width = "calc(" + ((1 - newRatio) * 100) + "% - 2px)";
    } else {
      child0.style.height = "calc(" + (newRatio * 100) + "% - 2px)";
      child2.style.height = "calc(" + ((1 - newRatio) * 100) + "% - 2px)";
    }
  }

  function onMouseUp() {
    dragging = false;
    document.body.classList.remove("pane-resizing");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  handle.addEventListener("mousedown", onMouseDown);

  // Touch support
  handle.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    dragging = true;
    var touch = e.touches[0];
    startPos = splitNode.direction === "horizontal" ? touch.clientX : touch.clientY;
    startRatio = splitNode.ratio;
    document.body.classList.add("pane-resizing");

    function onTouchMove(ev) {
      if (!dragging || ev.touches.length !== 1) return;
      var t = ev.touches[0];
      var rect = container.getBoundingClientRect();
      var totalSize = splitNode.direction === "horizontal" ? rect.width : rect.height;
      if (totalSize === 0) return;
      var currentPos = splitNode.direction === "horizontal" ? t.clientX : t.clientY;
      var delta = currentPos - startPos;
      var newRatio = startRatio + (delta / totalSize);
      newRatio = Math.max(0.15, Math.min(0.85, newRatio));
      splitNode.ratio = newRatio;
      var children = container.children;
      if (splitNode.direction === "horizontal") {
        children[0].style.width = "calc(" + (newRatio * 100) + "% - 2px)";
        children[2].style.width = "calc(" + ((1 - newRatio) * 100) + "% - 2px)";
      } else {
        children[0].style.height = "calc(" + (newRatio * 100) + "% - 2px)";
        children[2].style.height = "calc(" + ((1 - newRatio) * 100) + "% - 2px)";
      }
    }

    function onTouchEnd() {
      dragging = false;
      document.body.classList.remove("pane-resizing");
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    }

    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd);
  }, { passive: false });
}

function setupPaneDropTarget(container, paneId) {
  var overlay = null;

  container.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "pane-drop-overlay";
      container.appendChild(overlay);
    }

    // Detect cursor position for split direction
    var rect = container.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = (e.clientY - rect.top) / rect.height;
    var edge = 0.25; // edge zone for splits

    overlay.className = "pane-drop-overlay";
    if (x < edge) {
      overlay.classList.add("pane-drop-left");
    } else if (x > 1 - edge) {
      overlay.classList.add("pane-drop-right");
    } else if (y < edge) {
      overlay.classList.add("pane-drop-top");
    } else if (y > 1 - edge) {
      overlay.classList.add("pane-drop-bottom");
    } else {
      overlay.classList.add("pane-drop-center");
    }
  });

  container.addEventListener("dragleave", function (e) {
    // Only remove if leaving the container entirely
    if (!container.contains(e.relatedTarget)) {
      if (overlay) { overlay.remove(); overlay = null; }
    }
  });

  container.addEventListener("drop", function (e) {
    e.preventDefault();
    var sessionId = parseInt(e.dataTransfer.getData("text/x-clay-session"), 10);
    if (overlay) { overlay.remove(); overlay = null; }
    document.body.classList.remove("pane-drag-active");

    if (!sessionId || isNaN(sessionId)) return;

    // Don't split if dropping same session
    var existingState = paneStates[paneId];
    if (existingState && existingState.sessionId === sessionId) return;

    // Check if this session is already in a pane
    var existingPaneForSession = getPaneForSession(sessionId);
    if (existingPaneForSession) return; // Session already shown

    // Determine action from drop position
    var rect = container.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = (e.clientY - rect.top) / rect.height;
    var edge = 0.25;

    if (x < edge || x > 1 - edge) {
      splitPane(paneId, "horizontal", sessionId);
    } else if (y < edge || y > 1 - edge) {
      splitPane(paneId, "vertical", sessionId);
    } else {
      // Center = replace this pane's session
      replacePaneSession(paneId, sessionId);
    }
  });
}

function showPaneArea() {
  if (!paneArea) return;
  paneArea.classList.remove("hidden");
  var appEl = document.getElementById("app");
  if (appEl) appEl.classList.add("hidden");
}

function hidePaneArea() {
  if (!paneArea) return;
  paneArea.classList.add("hidden");
  var appEl = document.getElementById("app");
  if (appEl) appEl.classList.remove("hidden");
}

function getSessionTitle(sessionId) {
  // Try to get from cached sessions in sidebar
  if (ctx.getCachedSessions) {
    var sessions = ctx.getCachedSessions();
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) return sessions[i].title || "Session " + sessionId;
    }
  }
  return "Session " + sessionId;
}

// --- Mobile tab bar ---

function renderMobileTabBar() {
  if (!paneArea) return;
  paneArea.innerHTML = "";

  var tabBar = document.createElement("div");
  tabBar.className = "pane-tabs";

  forEachLeaf(treeRoot, function (leaf) {
    var tab = document.createElement("button");
    tab.className = "pane-tab";
    tab.dataset.paneId = leaf.paneId;
    tab.dataset.sessionId = leaf.sessionId;
    if (leaf.paneId === activePaneId) tab.classList.add("pane-tab-active");

    var titleSpan = document.createElement("span");
    titleSpan.className = "pane-tab-title";
    titleSpan.textContent = getSessionTitle(leaf.sessionId);
    tab.appendChild(titleSpan);

    var closeBtn = document.createElement("button");
    closeBtn.className = "pane-tab-close";
    closeBtn.innerHTML = "&#x2715;";
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closePane(leaf.paneId);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener("click", function () {
      setActivePane(leaf.paneId);
      renderMobileTabContent(leaf.paneId);
    });

    tabBar.appendChild(tab);
  });

  paneArea.appendChild(tabBar);

  // Render the active pane's content
  renderMobileTabContent(activePaneId);
}

function renderMobileTabContent(paneId) {
  // Remove old content (keep tab bar)
  var existing = paneArea.querySelector(".pane-mobile-content");
  if (existing) existing.remove();

  var state = paneStates[paneId];
  if (!state) return;

  var content = document.createElement("div");
  content.className = "pane-mobile-content";

  // Create pane DOM for the active tab
  var paneEl = createPaneDOM(paneId, state.sessionId);
  paneEl.querySelector(".pane-header").style.display = "none"; // hide header on mobile, tabs serve that purpose
  content.appendChild(paneEl);

  paneArea.appendChild(content);

  // Update tab active states
  var tabs = paneArea.querySelectorAll(".pane-tab");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle("pane-tab-active", tabs[i].dataset.paneId === paneId);
  }
}
