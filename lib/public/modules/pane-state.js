// pane-state.js — factory for per-pane state objects

var paneCounter = 0;

export function createPaneState(opts) {
  var id = "pane-" + (++paneCounter);
  return {
    id: id,
    ws: null,               // per-pane WebSocket connection
    projectSlug: opts.projectSlug || null, // null = current project (Phase 3: cross-project)
    sessionId: opts.sessionId || null,
    agentStatus: "idle",
    needsAttention: false,
    el: null,               // pane DOM element
    messagesEl: null,       // messages container inside pane
    headerEl: null,         // pane header element
    sessionTitle: opts.sessionTitle || "New Session",
    isPrimary: opts.isPrimary || false, // primary pane uses #main-column
  };
}

export function resetPaneCounter() {
  paneCounter = 0;
}
