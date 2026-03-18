// pane-renderer.js — per-pane rendering state and functions
//
// Extracted from app.js so each pane can render independently.
// Primary pane uses a singleton delegate; secondary panes get their own instance.

import { copyToClipboard, escapeHtml } from './utils.js';
import { refreshIcons, iconHtml, randomThinkingVerb } from './icons.js';
import { renderMarkdown, highlightCodeBlocks, renderMermaidBlocks } from './markdown.js';

// Known context window sizes per model (fallback when SDK omits feature flag)
var KNOWN_CONTEXT_WINDOWS = {
  "opus-4-6": 1000000,
  "claude-sonnet-4": 1000000
};

function resolveContextWindow(model, sdkValue) {
  if (sdkValue) return sdkValue;
  var lc = (model || "").toLowerCase();
  for (var key in KNOWN_CONTEXT_WINDOWS) {
    if (lc.includes(key)) return KNOWN_CONTEXT_WINDOWS[key];
  }
  return 200000;
}

function contextPctClass(pct) {
  return pct >= 85 ? " danger" : pct >= 60 ? " warn" : "";
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function rateLimitTypeLabel(type) {
  if (!type) return "Usage";
  var labels = {
    "five_hour": "5-hour",
    "seven_day": "7-day",
    "seven_day_opus": "7-day Opus",
    "seven_day_sonnet": "7-day Sonnet",
    "overage": "Overage",
  };
  return labels[type] || type;
}

// --- Factory ---

function createPaneRenderer(ctx) {
  // --- Per-pane rendering state ---
  var processing = false;
  var activityEl = null;
  var currentMsgEl = null;
  var currentFullText = "";
  var highlightTimer = null;
  var activeSessionId = null;
  var sessionDrafts = {};
  var turnCounter = 0;
  var messageUuidMap = [];
  var cliSessionId = null;

  // Progressive history loading
  var historyFrom = 0;
  var historyTotal = 0;
  var prependAnchor = null;
  var loadingMore = false;
  var historySentinelObserver = null;
  var replayingHistory = false;

  // Scroll lock
  var isUserScrolledUp = false;
  var scrollThreshold = 150;

  // Stream smoothing
  var streamBuffer = "";
  var streamDrainTimer = null;

  // Usage tracking
  var sessionUsage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

  // Context tracking
  var contextData = { contextWindow: 0, maxOutputTokens: 0, model: "-", cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  var headerContextEl = null;

  // Rate limit / fast mode
  var rateLimitCountdownTimer = null;
  var rateLimitIndicatorEl = null;
  var fastModeIndicatorEl = null;

  // Loop state (per-pane mirror of server's per-session loop state)
  var loopActive = false;
  var loopAvailable = false;
  var loopIteration = 0;
  var loopMaxIterations = 0;
  var ralphPhase = "idle";
  var ralphCraftingSessionId = null;

  // --- DOM refs (pane-scoped) ---
  var messagesEl = ctx.messagesEl;
  var inputEl = ctx.inputEl;
  var sendBtn = ctx.sendBtn;
  var connectOverlay = ctx.connectOverlay;
  var newMsgBtn = ctx.newMsgBtn;
  var suggestionChipsEl = ctx.suggestionChipsEl;

  // Usage panel DOM refs
  var usagePanel = ctx.$("usage-panel");
  var usageCostEl = ctx.$("usage-cost");
  var usageInputEl = ctx.$("usage-input");
  var usageOutputEl = ctx.$("usage-output");
  var usageCacheReadEl = ctx.$("usage-cache-read");
  var usageCacheWriteEl = ctx.$("usage-cache-write");
  var usageTurnsEl = ctx.$("usage-turns");
  var usagePanelClose = ctx.$("usage-panel-close");

  // Context panel DOM refs
  var contextPanel = ctx.$("context-panel");
  var contextPanelClose = ctx.$("context-panel-close");
  var contextPanelMinimize = ctx.$("context-panel-minimize");
  var contextBarFill = ctx.$("context-bar-fill");
  var contextBarPct = ctx.$("context-bar-pct");
  var contextUsedEl = ctx.$("context-used");
  var contextWindowEl = ctx.$("context-window");
  var contextMaxOutputEl = ctx.$("context-max-output");
  var contextInputEl = ctx.$("context-input");
  var contextOutputEl = ctx.$("context-output");
  var contextCacheReadEl = ctx.$("context-cache-read");
  var contextCacheWriteEl = ctx.$("context-cache-write");
  var contextModelEl = ctx.$("context-model");
  var contextCostEl = ctx.$("context-cost");
  var contextTurnsEl = ctx.$("context-turns");
  var contextMini = ctx.$("context-mini");
  var contextMiniFill = ctx.$("context-mini-fill");
  var contextMiniLabel = ctx.$("context-mini-label");

  var newMsgBtnDefault = "\u2193 Latest";
  var newMsgBtnActivity = "\u2193 New activity";

  // --- Usage panel event wiring ---
  if (usagePanelClose) {
    usagePanelClose.addEventListener("click", function () {
      if (usagePanel) usagePanel.classList.add("hidden");
    });
  }

  // --- Context panel event wiring ---
  if (contextPanelClose) {
    contextPanelClose.addEventListener("click", function () {
      setContextView("off");
      applyContextView("off");
    });
  }
  if (contextPanelMinimize) {
    contextPanelMinimize.addEventListener("click", function () {
      setContextView("mini");
      applyContextView("mini");
    });
  }
  if (contextMini) {
    contextMini.addEventListener("click", function () {
      setContextView("panel");
      applyContextView("panel");
    });
  }
  // Restore context view on init
  applyContextView(getContextView());

  // --- Scroll event wiring ---
  if (messagesEl) {
    messagesEl.addEventListener("scroll", function () {
      var distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      isUserScrolledUp = distFromBottom > scrollThreshold;
      if (isUserScrolledUp) {
        if (newMsgBtn && newMsgBtn.classList.contains("hidden")) {
          newMsgBtn.textContent = newMsgBtnDefault;
        }
        if (newMsgBtn) newMsgBtn.classList.remove("hidden");
      } else {
        if (newMsgBtn) newMsgBtn.classList.add("hidden");
        if (newMsgBtn) newMsgBtn.textContent = newMsgBtnDefault;
      }
    });
  }
  if (newMsgBtn) {
    newMsgBtn.addEventListener("click", function () {
      forceScrollToBottom();
    });
  }

  // --- Fork session handler ---
  if (messagesEl) {
    messagesEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".msg-action-fork");
      if (!btn) return;
      var msgEl = btn.closest("[data-uuid]");
      if (!msgEl || !msgEl.dataset.uuid) return;
      var forkUuid = msgEl.dataset.uuid;
      if (ctx.showConfirm) {
        ctx.showConfirm("Fork session from this message?", function () {
          var ws = ctx.ws;
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "fork_session", uuid: forkUuid }));
          }
        }, "Fork", false);
      }
    });
  }

  // ===== Rendering functions =====

  function setStatus(status) {
    if (ctx.getStatusDot) {
      var dot = ctx.getStatusDot();
      if (dot) dot.className = "icon-strip-status";
      if (status === "connected" && dot) dot.classList.add("connected");
      else if (status === "processing" && dot) {
        dot.classList.add("connected");
        dot.classList.add("processing");
      }
    }
    if (status === "connected") {
      processing = false;
      if (sendBtn) sendBtn.disabled = false;
      if (ctx.setSendBtnMode) ctx.setSendBtnMode("send");
      if (connectOverlay) connectOverlay.classList.add("hidden");
      if (ctx.stopVerbCycle) ctx.stopVerbCycle();
    } else if (status === "processing") {
      processing = true;
      if (ctx.setSendBtnMode) ctx.setSendBtnMode(inputEl && inputEl.value.trim() ? "send" : "stop");
    } else {
      processing = false;
      if (sendBtn) sendBtn.disabled = true;
      if (connectOverlay) connectOverlay.classList.remove("hidden");
      if (ctx.startVerbCycle) ctx.startVerbCycle();
    }
  }

  function setActivity(text) {
    if (text) {
      if (!activityEl) {
        activityEl = document.createElement("div");
        activityEl.className = "activity-inline";
        activityEl.innerHTML =
          '<span class="activity-icon">' + iconHtml("sparkles") + '</span>' +
          '<span class="activity-text"></span>';
        addToMessages(activityEl);
        refreshIcons();
      }
      activityEl.querySelector(".activity-text").textContent = text;
      scrollToBottom();
    } else {
      if (activityEl) {
        activityEl.remove();
        activityEl = null;
      }
    }
  }

  function addToMessages(el) {
    if (prependAnchor) messagesEl.insertBefore(el, prependAnchor);
    else messagesEl.appendChild(el);
  }

  function scrollToBottom() {
    if (prependAnchor) return;
    if (isUserScrolledUp) {
      if (newMsgBtn) {
        newMsgBtn.textContent = newMsgBtnActivity;
        newMsgBtn.classList.remove("hidden");
      }
      return;
    }
    requestAnimationFrame(function () {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function forceScrollToBottom() {
    if (prependAnchor) return;
    isUserScrolledUp = false;
    if (newMsgBtn) {
      newMsgBtn.classList.add("hidden");
      newMsgBtn.textContent = newMsgBtnDefault;
    }
    requestAnimationFrame(function () {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function addUserMessage(text, images, pastes) {
    if (!text && (!images || images.length === 0) && (!pastes || pastes.length === 0)) return;
    var div = document.createElement("div");
    div.className = "msg-user";
    div.dataset.turn = ++turnCounter;
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.dir = "auto";

    if (images && images.length > 0) {
      var imgRow = document.createElement("div");
      imgRow.className = "bubble-images";
      for (var i = 0; i < images.length; i++) {
        var img = document.createElement("img");
        img.src = "data:" + images[i].mediaType + ";base64," + images[i].data;
        img.className = "bubble-img";
        img.addEventListener("click", function () { if (ctx.showImageModal) ctx.showImageModal(this.src); });
        imgRow.appendChild(img);
      }
      bubble.appendChild(imgRow);
    }

    if (pastes && pastes.length > 0) {
      var pasteRow = document.createElement("div");
      pasteRow.className = "bubble-pastes";
      for (var p = 0; p < pastes.length; p++) {
        (function (pasteText) {
          var chip = document.createElement("div");
          chip.className = "bubble-paste";
          var preview = pasteText.substring(0, 60).replace(/\n/g, " ");
          if (pasteText.length > 60) preview += "...";
          chip.innerHTML = '<span class="bubble-paste-preview">' + escapeHtml(preview) + '</span><span class="bubble-paste-label">PASTED</span>';
          chip.addEventListener("click", function (e) {
            e.stopPropagation();
            if (ctx.showPasteModal) ctx.showPasteModal(pasteText);
          });
          pasteRow.appendChild(chip);
        })(pastes[p]);
      }
      bubble.appendChild(pasteRow);
    }

    if (text) {
      var textEl = document.createElement("span");
      textEl.textContent = text;
      bubble.appendChild(textEl);
    }

    div.appendChild(bubble);

    // Action bar below bubble
    var actions = document.createElement("div");
    actions.className = "msg-actions";
    var now = new Date();
    var timeStr = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    actions.innerHTML =
      '<span class="msg-action-time">' + timeStr + '</span>' +
      '<button class="msg-action-btn msg-action-copy" type="button" title="Copy">' + iconHtml("copy") + '</button>' +
      '<button class="msg-action-btn msg-action-fork" type="button" title="Fork">' + iconHtml("git-branch") + '</button>' +
      '<button class="msg-action-btn msg-action-rewind msg-user-rewind-btn" type="button" title="Rewind">' + iconHtml("rotate-ccw") + '</button>' +
      '<button class="msg-action-btn msg-action-hidden msg-action-edit" type="button" title="Edit">' + iconHtml("pencil") + '</button>';
    div.appendChild(actions);

    // Copy handler
    actions.querySelector(".msg-action-copy").addEventListener("click", function () {
      var self = this;
      copyToClipboard(text || "");
      self.innerHTML = iconHtml("check");
      refreshIcons();
      setTimeout(function () { self.innerHTML = iconHtml("copy"); refreshIcons(); }, 1200);
    });

    addToMessages(div);
    refreshIcons();
    forceScrollToBottom();
  }

  function ensureAssistantBlock() {
    if (!currentMsgEl) {
      currentMsgEl = document.createElement("div");
      currentMsgEl.className = "msg-assistant";
      currentMsgEl.dataset.turn = turnCounter;
      currentMsgEl.innerHTML = '<div class="md-content" dir="auto"></div>';
      addToMessages(currentMsgEl);
      currentFullText = "";
    }
    return currentMsgEl;
  }

  function addCopyHandler(msgEl, rawText) {
    var primed = false;
    var resetTimer = null;
    var isTouchDevice = "ontouchstart" in window;
    var hint = document.createElement("div");
    hint.className = "msg-copy-hint";
    hint.textContent = (isTouchDevice ? "Tap" : "Click") + " to grab this";
    msgEl.appendChild(hint);

    function reset() {
      primed = false;
      msgEl.classList.remove("copy-primed", "copy-done");
      hint.textContent = (isTouchDevice ? "Tap" : "Click") + " to grab this";
    }

    msgEl.addEventListener("click", function (e) {
      if (e.target.closest("a, pre, code")) return;
      var sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      if (!primed) {
        primed = true;
        msgEl.classList.add("copy-primed");
        hint.textContent = isTouchDevice ? "Tap again to grab" : "Click again to grab";
        clearTimeout(resetTimer);
        resetTimer = setTimeout(reset, 3000);
      } else {
        clearTimeout(resetTimer);
        copyToClipboard(rawText).then(function () {
          msgEl.classList.remove("copy-primed");
          msgEl.classList.add("copy-done");
          hint.textContent = "Grabbed!";
          resetTimer = setTimeout(reset, 1500);
        });
      }
    });

    document.addEventListener("click", function (e) {
      if (primed && !msgEl.contains(e.target)) reset();
    });
  }

  function appendDelta(text) {
    ensureAssistantBlock();
    streamBuffer += text;
    if (!streamDrainTimer) {
      streamDrainTimer = requestAnimationFrame(drainStreamTick);
    }
  }

  function drainStreamTick() {
    streamDrainTimer = null;
    if (!currentMsgEl || streamBuffer.length === 0) return;

    var n;
    var len = streamBuffer.length;
    if (len > 200) { n = Math.ceil(len / 4); }
    else if (len > 80) { n = 8; }
    else if (len > 30) { n = 5; }
    else if (len > 10) { n = 2; }
    else { n = 1; }

    var chunk = streamBuffer.slice(0, n);
    streamBuffer = streamBuffer.slice(n);
    currentFullText += chunk;

    var contentEl = currentMsgEl.querySelector(".md-content");
    contentEl.innerHTML = renderMarkdown(currentFullText);

    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(function () {
      highlightCodeBlocks(contentEl);
    }, 150);

    scrollToBottom();

    if (streamBuffer.length > 0) {
      streamDrainTimer = requestAnimationFrame(drainStreamTick);
    }
  }

  function flushStreamBuffer() {
    if (streamDrainTimer) { cancelAnimationFrame(streamDrainTimer); streamDrainTimer = null; }
    if (streamBuffer.length > 0) {
      currentFullText += streamBuffer;
      streamBuffer = "";
    }
    if (currentMsgEl) {
      var contentEl = currentMsgEl.querySelector(".md-content");
      if (contentEl) {
        contentEl.innerHTML = renderMarkdown(currentFullText);
        highlightCodeBlocks(contentEl);
      }
    }
  }

  function finalizeAssistantBlock() {
    flushStreamBuffer();
    if (currentMsgEl) {
      var contentEl = currentMsgEl.querySelector(".md-content");
      if (contentEl) {
        highlightCodeBlocks(contentEl);
        renderMermaidBlocks(contentEl);
      }
      if (currentFullText) {
        addCopyHandler(currentMsgEl, currentFullText);
      }
      // Close tool group via tools module
      var tools = getToolsModule();
      if (tools) tools.closeToolGroup();
    }
    currentMsgEl = null;
    currentFullText = "";
  }

  function addSystemMessage(text, isError) {
    var div = document.createElement("div");
    div.className = "sys-msg" + (isError ? " error" : "");
    div.innerHTML = '<span class="sys-text"></span>';
    div.querySelector(".sys-text").textContent = text;
    addToMessages(div);
    scrollToBottom();
  }

  function addConflictMessage(msg) {
    var div = document.createElement("div");
    div.className = "conflict-msg";
    var header = document.createElement("div");
    header.className = "conflict-header";
    header.textContent = msg.text || "Another Claude Code process is already running.";
    div.appendChild(header);

    var hint = document.createElement("div");
    hint.className = "conflict-hint";
    hint.textContent = "Kill the conflicting process to continue, or use the existing Claude Code session.";
    div.appendChild(hint);

    for (var i = 0; i < msg.processes.length; i++) {
      var p = msg.processes[i];
      var row = document.createElement("div");
      row.className = "conflict-process";

      var info = document.createElement("span");
      info.className = "conflict-pid";
      info.textContent = "PID " + p.pid;
      row.appendChild(info);

      var cmd = document.createElement("code");
      cmd.className = "conflict-cmd";
      cmd.textContent = p.command.length > 80 ? p.command.substring(0, 80) + "..." : p.command;
      cmd.title = p.command;
      row.appendChild(cmd);

      var killBtn = document.createElement("button");
      killBtn.className = "conflict-kill-btn";
      killBtn.textContent = "Kill Process";
      killBtn.setAttribute("data-pid", p.pid);
      killBtn.addEventListener("click", function () {
        var pid = parseInt(this.getAttribute("data-pid"), 10);
        var ws = ctx.ws;
        if (ws) ws.send(JSON.stringify({ type: "kill_process", pid: pid }));
        this.disabled = true;
        this.textContent = "Killing...";
      });
      row.appendChild(killBtn);
      div.appendChild(row);
    }

    addToMessages(div);
    scrollToBottom();
  }

  function addContextOverflowMessage(msg) {
    var div = document.createElement("div");
    div.className = "context-overflow-msg";

    var header = document.createElement("div");
    header.className = "context-overflow-header";
    header.textContent = msg.text || "Conversation too long to continue.";
    div.appendChild(header);

    var hint = document.createElement("div");
    hint.className = "context-overflow-hint";
    hint.textContent = "The conversation has exceeded the model's context limit. Please start a new conversation to continue.";
    div.appendChild(hint);

    var btn = document.createElement("button");
    btn.className = "context-overflow-btn";
    btn.textContent = "New Conversation";
    btn.addEventListener("click", function () {
      var ws = ctx.ws;
      if (ws) ws.send(JSON.stringify({ type: "new_session" }));
    });
    div.appendChild(btn);

    addToMessages(div);
    scrollToBottom();
  }

  // --- Usage tracking ---

  function updateUsagePanel() {
    if (!usageCostEl) return;
    usageCostEl.textContent = "$" + sessionUsage.cost.toFixed(4);
    usageInputEl.textContent = formatTokens(sessionUsage.input);
    usageOutputEl.textContent = formatTokens(sessionUsage.output);
    usageCacheReadEl.textContent = formatTokens(sessionUsage.cacheRead);
    usageCacheWriteEl.textContent = formatTokens(sessionUsage.cacheWrite);
    usageTurnsEl.textContent = String(sessionUsage.turns);
  }

  function accumulateUsage(cost, usage) {
    if (cost != null) sessionUsage.cost += cost;
    if (usage) {
      sessionUsage.input += usage.input_tokens || usage.inputTokens || 0;
      sessionUsage.output += usage.output_tokens || usage.outputTokens || 0;
      sessionUsage.cacheRead += usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0;
      sessionUsage.cacheWrite += usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0;
    }
    sessionUsage.turns++;
    if (!replayingHistory) updateUsagePanel();
  }

  function resetUsage() {
    sessionUsage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    updateUsagePanel();
    if (usagePanel) usagePanel.classList.add("hidden");
  }

  function toggleUsagePanel() {
    if (!usagePanel) return;
    usagePanel.classList.toggle("hidden");
    refreshIcons();
  }

  // --- Context tracking ---

  function updateContextPanel() {
    if (!contextUsedEl) return;
    var used = contextData.input;
    var win = contextData.contextWindow;
    var pct = win > 0 ? Math.min(100, (used / win) * 100) : 0;
    var cls = contextPctClass(pct);
    // Panel bar
    if (contextBarFill) {
      contextBarFill.style.width = pct.toFixed(1) + "%";
      contextBarFill.className = "context-bar-fill" + cls;
    }
    if (contextBarPct) contextBarPct.textContent = pct.toFixed(0) + "%";
    // Mini bar
    if (contextMiniFill) {
      contextMiniFill.style.width = pct.toFixed(1) + "%";
      contextMiniFill.className = "context-mini-fill" + cls;
    }
    if (contextMiniLabel) {
      contextMiniLabel.textContent = (win > 0 ? formatTokens(used) + "/" + formatTokens(win) : "0%");
    }
    // Header bar indicator
    if (pct > 0) {
      var statusArea = ctx.getStatusArea ? ctx.getStatusArea() : null;
      if (statusArea && !headerContextEl) {
        headerContextEl = document.createElement("div");
        headerContextEl.className = "header-context";
        headerContextEl.innerHTML = '<div class="header-context-bar"><div class="header-context-fill"></div></div><span class="header-context-label"></span>';
        statusArea.insertBefore(headerContextEl, statusArea.firstChild);
      }
      if (headerContextEl) {
        var hFill = headerContextEl.querySelector(".header-context-fill");
        var hLabel = headerContextEl.querySelector(".header-context-label");
        hFill.style.width = pct.toFixed(1) + "%";
        hFill.className = "header-context-fill" + cls;
        hLabel.textContent = pct.toFixed(0) + "%";
        headerContextEl.dataset.tip = "Context window " + pct.toFixed(0) + "% used (" + formatTokens(used) + " / " + formatTokens(win) + " tokens)";
      }
    }
    if (contextUsedEl) contextUsedEl.textContent = formatTokens(used);
    if (contextWindowEl) contextWindowEl.textContent = win > 0 ? formatTokens(win) : "-";
    if (contextMaxOutputEl) contextMaxOutputEl.textContent = contextData.maxOutputTokens > 0 ? formatTokens(contextData.maxOutputTokens) : "-";
    if (contextInputEl) contextInputEl.textContent = formatTokens(contextData.input);
    if (contextOutputEl) contextOutputEl.textContent = formatTokens(contextData.output);
    if (contextCacheReadEl) contextCacheReadEl.textContent = formatTokens(contextData.cacheRead);
    if (contextCacheWriteEl) contextCacheWriteEl.textContent = formatTokens(contextData.cacheWrite);
    if (contextModelEl) contextModelEl.textContent = contextData.model;
    if (contextCostEl) contextCostEl.textContent = "$" + contextData.cost.toFixed(4);
    if (contextTurnsEl) contextTurnsEl.textContent = String(contextData.turns);
  }

  function accumulateContext(cost, usage, modelUsage, lastStreamInputTokens) {
    if (cost != null) contextData.cost += cost;
    if (usage) {
      if (lastStreamInputTokens) {
        contextData.input = lastStreamInputTokens;
      } else {
        contextData.input = (usage.input_tokens || usage.inputTokens || 0)
            + (usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0);
      }
      contextData.output = usage.output_tokens || usage.outputTokens || 0;
      contextData.cacheRead = usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0;
      contextData.cacheWrite = usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0;
    }
    contextData.turns++;
    if (modelUsage) {
      var models = Object.keys(modelUsage);
      if (models.length > 0) {
        var m = models[0];
        var mu = modelUsage[m];
        contextData.model = m;
        contextData.contextWindow = resolveContextWindow(m, mu.contextWindow);
        if (mu.maxOutputTokens) contextData.maxOutputTokens = mu.maxOutputTokens;
      }
    }
    if (!replayingHistory) updateContextPanel();
  }

  function getContextView() {
    try { return localStorage.getItem("clay-context-view") || "off"; } catch (e) { return "off"; }
  }
  function setContextView(v) {
    try { localStorage.setItem("clay-context-view", v); } catch (e) {}
  }
  function applyContextView(view) {
    if (contextPanel) contextPanel.classList.toggle("hidden", view !== "panel");
    if (contextMini) contextMini.classList.toggle("hidden", view !== "mini");
    if (view === "panel") refreshIcons();
  }

  function resetContextData() {
    contextData = { contextWindow: 0, maxOutputTokens: 0, model: "-", cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
    updateContextPanel();
  }

  function resetContext() {
    resetContextData();
    applyContextView(getContextView());
  }

  function toggleContextPanel() {
    if (!contextPanel) return;
    var view = getContextView();
    if (view === "panel") {
      setContextView("mini");
      applyContextView("mini");
    } else {
      setContextView("panel");
      applyContextView("panel");
    }
  }

  function getContextPercent() {
    var used = contextData.input;
    var win = contextData.contextWindow;
    return win > 0 ? Math.round((used / win) * 100) : 0;
  }

  // --- Rate limit ---

  function updateRateLimitIndicator(msg) {
    var statusArea = ctx.getStatusArea ? ctx.getStatusArea() : null;
    if (!statusArea) return;
    if (!rateLimitIndicatorEl) {
      rateLimitIndicatorEl = document.createElement("span");
      rateLimitIndicatorEl.className = "header-rate-limit-wrap";
      statusArea.insertBefore(rateLimitIndicatorEl, statusArea.firstChild);
    }
    var isRejected = msg.status === "rejected";
    var pillClass = "header-rate-limit" + (isRejected ? " rejected" : " warning");
    var label = isRejected ? "Rate limited" : "Rate warning";
    rateLimitIndicatorEl.innerHTML =
      '<span class="' + pillClass + '">' +
        iconHtml("alert-triangle") +
        '<span class="header-pill-text">' + label + "</span>" +
        '<a href="https://claude.ai/settings/usage" target="_blank" rel="noopener" class="rate-limit-link">' +
          iconHtml("external-link") +
        "</a>" +
      "</span>";
    refreshIcons();
  }

  function showRateLimitPopover(text, isRejected) {
    if (!rateLimitIndicatorEl) return;
    var old = rateLimitIndicatorEl.querySelector(".rate-limit-popover");
    if (old) old.remove();
    var pop = document.createElement("div");
    pop.className = "rate-limit-popover" + (isRejected ? " rejected" : "");
    pop.textContent = text;
    rateLimitIndicatorEl.appendChild(pop);
    setTimeout(function () {
      pop.classList.add("fade-out");
      setTimeout(function () { if (pop.parentNode) pop.remove(); }, 300);
    }, 5000);
  }

  function startRateLimitCountdown(el, resetsAt, cardEl) {
    if (rateLimitCountdownTimer) clearInterval(rateLimitCountdownTimer);
    function tick() {
      var remaining = resetsAt - Date.now();
      if (remaining <= 0) {
        clearInterval(rateLimitCountdownTimer);
        rateLimitCountdownTimer = null;
        clearRateLimitIndicator();
        return;
      }
      if (rateLimitIndicatorEl) {
        var pillText = rateLimitIndicatorEl.querySelector(".header-pill-text");
        if (pillText) {
          var mins = Math.floor(remaining / 60000);
          var secs = Math.floor((remaining % 60000) / 1000);
          if (mins >= 60) {
            var hrs = Math.floor(mins / 60);
            mins = mins % 60;
            pillText.textContent = hrs + "h " + mins + "m";
          } else {
            pillText.textContent = mins + "m " + secs + "s";
          }
        }
      }
    }
    tick();
    rateLimitCountdownTimer = setInterval(tick, 1000);
  }

  function clearRateLimitIndicator() {
    if (rateLimitIndicatorEl) {
      rateLimitIndicatorEl.remove();
      rateLimitIndicatorEl = null;
    }
  }

  function handleRateLimitEvent(msg) {
    var isRejected = msg.status === "rejected";
    var typeLabel = rateLimitTypeLabel(msg.rateLimitType);
    var popoverText = "";
    if (isRejected && msg.resetsAt) {
      if (msg.resetsAt < Date.now()) {
        updateRateLimitIndicator(msg);
        return;
      }
      popoverText = typeLabel + " limit exceeded";
      updateRateLimitIndicator(msg);
      startRateLimitCountdown(null, msg.resetsAt, null);
    } else {
      var pct = msg.utilization ? Math.round(msg.utilization * 100) : null;
      popoverText = typeLabel + " warning" + (pct ? " (" + pct + "% used)" : "");
      updateRateLimitIndicator(msg);
    }
    showRateLimitPopover(popoverText, isRejected);
  }

  // --- Fast mode ---

  function handleFastModeState(state) {
    var statusArea = ctx.getStatusArea ? ctx.getStatusArea() : null;
    if (!statusArea) return;
    if (state === "off") {
      if (fastModeIndicatorEl) {
        fastModeIndicatorEl.remove();
        fastModeIndicatorEl = null;
      }
      return;
    }
    if (!fastModeIndicatorEl) {
      fastModeIndicatorEl = document.createElement("span");
      statusArea.insertBefore(fastModeIndicatorEl, statusArea.firstChild);
    }
    if (state === "cooldown") {
      fastModeIndicatorEl.className = "header-fast-mode cooldown";
      fastModeIndicatorEl.innerHTML = iconHtml("timer") + '<span class="header-pill-text">Cooldown</span>';
    } else if (state === "on") {
      fastModeIndicatorEl.className = "header-fast-mode active";
      fastModeIndicatorEl.innerHTML = iconHtml("zap") + '<span class="header-pill-text">Fast mode</span>';
    }
    refreshIcons();
  }

  // --- Suggestion chips ---

  function showSuggestionChips(suggestion) {
    if (!suggestion || processing || !suggestionChipsEl) return;
    suggestionChipsEl.innerHTML = "";
    var chip = document.createElement("button");
    chip.className = "suggestion-chip";
    chip.innerHTML =
      '<span class="suggestion-chip-send">' + iconHtml("sparkles") +
      '<span class="suggestion-chip-text">' + escapeHtml(suggestion) + '</span></span>' +
      '<span class="suggestion-chip-edit">' + iconHtml("pencil") + '</span>';
    chip.addEventListener("click", function () {
      if (inputEl) inputEl.value = suggestion;
      hideSuggestionChips();
      if (ctx.sendMessage) ctx.sendMessage();
    });
    chip.querySelector(".suggestion-chip-edit").addEventListener("click", function (e) {
      e.stopPropagation();
      if (inputEl) {
        inputEl.value = suggestion;
        inputEl.focus();
        inputEl.select();
      }
      if (ctx.autoResize) ctx.autoResize();
      hideSuggestionChips();
    });
    suggestionChipsEl.appendChild(chip);
    suggestionChipsEl.classList.remove("hidden");
    refreshIcons();
  }

  function hideSuggestionChips() {
    if (!suggestionChipsEl) return;
    suggestionChipsEl.innerHTML = "";
    suggestionChipsEl.classList.add("hidden");
  }

  // --- History loading ---

  function requestMoreHistory() {
    if (loadingMore || historyFrom <= 0) return;
    var ws = ctx.ws;
    if (!ws || !ctx.connected) return;
    loadingMore = true;
    var btn = messagesEl.querySelector(".load-more-btn");
    if (btn) btn.classList.add("loading");
    ws.send(JSON.stringify({ type: "load_more_history", before: historyFrom }));
  }

  function updateHistorySentinel() {
    var existing = messagesEl.querySelector(".history-sentinel");
    if (historyFrom > 0) {
      if (!existing) {
        var sentinel = document.createElement("div");
        sentinel.className = "history-sentinel";
        sentinel.innerHTML = '<button class="load-more-btn">Load earlier messages</button>';
        sentinel.querySelector(".load-more-btn").addEventListener("click", function () {
          requestMoreHistory();
        });
        messagesEl.insertBefore(sentinel, messagesEl.firstChild);

        if (historySentinelObserver) historySentinelObserver.disconnect();
        historySentinelObserver = new IntersectionObserver(function (entries) {
          if (entries[0].isIntersecting && !loadingMore && historyFrom > 0) {
            requestMoreHistory();
          }
        }, { root: messagesEl, rootMargin: "200px 0px 0px 0px" });
        historySentinelObserver.observe(sentinel);
      }
    } else {
      if (existing) existing.remove();
      if (historySentinelObserver) { historySentinelObserver.disconnect(); historySentinelObserver = null; }
    }
  }

  function prependOlderHistory(items, meta) {
    // Save current rendering state
    var savedMsgEl = currentMsgEl;
    var savedActivity = activityEl;
    var savedFullText = currentFullText;
    var savedTurnCounter = turnCounter;
    var tools = getToolsModule();
    var savedToolsState = tools ? tools.saveToolState() : null;
    var savedContext = JSON.parse(JSON.stringify(contextData));
    var savedUsage = JSON.parse(JSON.stringify(sessionUsage));

    // Reset to initial values
    currentMsgEl = null;
    activityEl = null;
    currentFullText = "";
    turnCounter = 0;
    if (tools) tools.resetToolState();

    // Set prepend anchor
    var firstReal = messagesEl.querySelector(".history-sentinel");
    prependAnchor = firstReal ? firstReal.nextSibling : messagesEl.firstChild;

    var anchorEl = prependAnchor;
    var anchorOffset = anchorEl ? anchorEl.getBoundingClientRect().top : 0;

    // Replay items through message processor
    for (var i = 0; i < items.length; i++) {
      processPaneMessage(items[i]);
    }

    finalizeAssistantBlock();
    prependAnchor = null;

    // Restore saved state
    currentMsgEl = savedMsgEl;
    activityEl = savedActivity;
    currentFullText = savedFullText;
    turnCounter = savedTurnCounter;
    if (tools && savedToolsState) tools.restoreToolState(savedToolsState);
    contextData = savedContext;
    sessionUsage = savedUsage;
    updateContextPanel();
    updateUsagePanel();

    // Fix scroll
    if (anchorEl) {
      var newTop = anchorEl.getBoundingClientRect().top;
      messagesEl.scrollTop += (newTop - anchorOffset);
    }

    historyFrom = meta.from;
    loadingMore = false;

    // Renumber data-turn attributes
    var turnEls = messagesEl.querySelectorAll("[data-turn]");
    for (var t = 0; t < turnEls.length; t++) {
      turnEls[t].dataset.turn = t + 1;
    }
    turnCounter = turnEls.length;

    if (meta.hasMore) {
      var btn = messagesEl.querySelector(".load-more-btn");
      if (btn) btn.classList.remove("loading");
    } else {
      updateHistorySentinel();
    }
  }

  // --- Master reset ---

  function resetClientState() {
    messagesEl.innerHTML = "";
    currentMsgEl = null;
    currentFullText = "";
    var tools = getToolsModule();
    if (tools) tools.resetToolState();
    if (ctx.clearPendingImages) ctx.clearPendingImages();
    activityEl = null;
    processing = false;
    turnCounter = 0;
    messageUuidMap = [];
    historyFrom = 0;
    historyTotal = 0;
    prependAnchor = null;
    loadingMore = false;
    isUserScrolledUp = false;
    if (newMsgBtn) newMsgBtn.classList.add("hidden");
    if (ctx.setRewindMode) ctx.setRewindMode(false);
    if (ctx.removeSearchTimeline) ctx.removeSearchTimeline();
    setActivity(null);
    setStatus("connected");
    if (!loopActive && ctx.enableMainInput) ctx.enableMainInput();
    resetUsage();
    resetContext();
    clearRateLimitIndicator();
    if (rateLimitCountdownTimer) { clearInterval(rateLimitCountdownTimer); rateLimitCountdownTimer = null; }
    if (fastModeIndicatorEl) { fastModeIndicatorEl.remove(); fastModeIndicatorEl = null; }
    if (headerContextEl) { headerContextEl.remove(); headerContextEl = null; }
    hideSuggestionChips();
    if (ctx.closeSessionInfoPopover) ctx.closeSessionInfoPopover();
    if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();
  }

  // --- Tools module accessor ---
  function getToolsModule() {
    if (ctx.modules && ctx.modules.tools) return ctx.modules.tools;
    // For primary pane, fall back to ctx.toolsSingleton
    if (ctx.toolsSingleton) return ctx.toolsSingleton;
    return null;
  }

  // --- processPaneMessage ---

  function processPaneMessage(msg) {
    var tools = getToolsModule();
    switch (msg.type) {
      case "history_meta":
        historyFrom = msg.from;
        historyTotal = msg.total;
        replayingHistory = true;
        updateHistorySentinel();
        break;

      case "history_prepend":
        prependOlderHistory(msg.items, msg.meta);
        break;

      case "history_done":
        replayingHistory = false;
        if (msg.lastUsage || msg.lastModelUsage) {
          accumulateContext(msg.lastCost, msg.lastUsage, msg.lastModelUsage, msg.lastStreamInputTokens);
        }
        updateContextPanel();
        updateUsagePanel();
        if (currentMsgEl && currentFullText) {
          var replayContentEl = currentMsgEl.querySelector(".md-content");
          if (replayContentEl) {
            replayContentEl.innerHTML = renderMarkdown(currentFullText);
          }
        }
        if (tools) tools.markAllToolsDone();
        finalizeAssistantBlock();
        if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();
        scrollToBottom();
        if (ctx.getActiveSearchQuery) {
          var pendingQuery = ctx.getActiveSearchQuery();
          if (pendingQuery) {
            requestAnimationFrame(function () { if (ctx.buildSearchTimeline) ctx.buildSearchTimeline(pendingQuery); });
          }
        }
        // Scroll to tool element if navigating from file edit history
        if (ctx.getPendingNavigate) {
          var nav = ctx.getPendingNavigate();
          if (nav && (nav.toolId || nav.assistantUuid)) {
            requestAnimationFrame(function () {
              var target = nav.toolId ? messagesEl.querySelector('[data-tool-id="' + nav.toolId + '"]') : null;
              if (!target && nav.assistantUuid) {
                target = messagesEl.querySelector('[data-uuid="' + nav.assistantUuid + '"]');
              }
              if (target) {
                var parentGroup = target.closest(".tool-group");
                if (parentGroup) parentGroup.classList.remove("collapsed");
                target.scrollIntoView({ behavior: "smooth", block: "center" });
                target.classList.add("message-blink");
                setTimeout(function () { target.classList.remove("message-blink"); }, 2000);
              }
            });
          }
        }
        break;

      case "input_sync":
        if (ctx.handleInputSync) ctx.handleInputSync(msg.text);
        break;

      case "session_switched":
        if (ctx.hideHomeHub) ctx.hideHomeHub();
        // Save draft from outgoing session
        if (activeSessionId && inputEl && inputEl.value) {
          sessionDrafts[activeSessionId] = inputEl.value;
        } else if (activeSessionId) {
          delete sessionDrafts[activeSessionId];
        }
        activeSessionId = msg.id;
        cliSessionId = msg.cliSessionId || null;
        resetClientState();
        if (ctx.updateRalphBars) ctx.updateRalphBars();
        if (ctx.updateLoopInputVisibility) ctx.updateLoopInputVisibility(msg.loop);
        // Restore draft for incoming session
        var draft = sessionDrafts[activeSessionId] || "";
        if (inputEl) inputEl.value = draft;
        if (ctx.autoResize) ctx.autoResize();
        if (inputEl && !("ontouchstart" in window)) {
          inputEl.focus();
        }
        // Notify pane manager of session switch
        if (ctx.onSessionSwitched) {
          ctx.onSessionSwitched(msg.id, msg.title || "Session");
        }
        break;

      case "session_id":
        cliSessionId = msg.cliSessionId;
        break;

      case "message_uuid":
        var uuidTarget;
        if (msg.messageType === "user") {
          var allUsers = messagesEl.querySelectorAll(".msg-user:not([data-uuid])");
          if (allUsers.length > 0) uuidTarget = allUsers[allUsers.length - 1];
        } else {
          var allAssistants = messagesEl.querySelectorAll(".msg-assistant:not([data-uuid])");
          if (allAssistants.length > 0) uuidTarget = allAssistants[allAssistants.length - 1];
        }
        if (uuidTarget) {
          uuidTarget.dataset.uuid = msg.uuid;
          if (msg.messageType === "user" && ctx.addRewindButton) ctx.addRewindButton(uuidTarget);
        }
        messageUuidMap.push({ uuid: msg.uuid, type: msg.messageType });
        break;

      case "user_message":
        if (tools) tools.resetThinkingGroup();
        if (msg.planContent) {
          if (tools) {
            tools.setPlanContent(msg.planContent);
            tools.renderPlanCard(msg.planContent);
          }
          addUserMessage("Execute the following plan. Do NOT re-enter plan mode \u2014 just implement it step by step.", msg.images || null, msg.pastes || null);
        } else {
          addUserMessage(msg.text, msg.images || null, msg.pastes || null);
        }
        break;

      case "status":
        if (msg.status === "processing") {
          setStatus("processing");
          setActivity(randomThinkingVerb() + "...");
        }
        break;

      case "compacting":
        if (msg.active) {
          setActivity("Compacting conversation...");
        } else {
          setActivity(randomThinkingVerb() + "...");
        }
        break;

      case "thinking_start":
        if (tools) tools.startThinking();
        break;

      case "thinking_delta":
        if (typeof msg.text === "string" && tools) tools.appendThinking(msg.text);
        break;

      case "thinking_stop":
        if (tools) tools.stopThinking(msg.duration);
        setActivity(randomThinkingVerb() + "...");
        break;

      case "delta":
        if (typeof msg.text !== "string") break;
        if (tools) { tools.stopThinking(); tools.resetThinkingGroup(); }
        setActivity(null);
        appendDelta(msg.text);
        break;

      case "tool_start":
        if (tools) {
          tools.stopThinking();
          tools.markAllToolsDone();
          if (msg.name === "EnterPlanMode") {
            tools.renderPlanBanner("enter");
            tools.getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
          } else if (msg.name === "ExitPlanMode") {
            if (tools.getPlanContent()) {
              tools.renderPlanCard(tools.getPlanContent());
            }
            tools.renderPlanBanner("exit");
            tools.getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
          } else if (tools.getTodoTools()[msg.name]) {
            tools.getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
          } else {
            tools.createToolItem(msg.id, msg.name);
          }
        }
        break;

      case "tool_executing":
        if (!tools) break;
        if (msg.name === "AskUserQuestion" && msg.input && msg.input.questions) {
          var askTool = tools.getTools()[msg.id];
          if (askTool) {
            if (askTool.el) askTool.el.style.display = "none";
            askTool.done = true;
            tools.removeToolFromGroup(msg.id);
          }
          tools.renderAskUserQuestion(msg.id, msg.input);
          if (ctx.startUrgentBlink) ctx.startUrgentBlink();
        } else if (msg.name === "Write" && msg.input && tools.isPlanFilePath(msg.input.file_path)) {
          tools.setPlanContent(msg.input.content || "");
          tools.updateToolExecuting(msg.id, msg.name, msg.input);
        } else if (msg.name === "Edit" && msg.input && tools.isPlanFilePath(msg.input.file_path)) {
          var pc = tools.getPlanContent() || "";
          if (msg.input.old_string && pc.indexOf(msg.input.old_string) !== -1) {
            if (msg.input.replace_all) {
              tools.setPlanContent(pc.split(msg.input.old_string).join(msg.input.new_string || ""));
            } else {
              tools.setPlanContent(pc.replace(msg.input.old_string, msg.input.new_string || ""));
            }
          }
          tools.updateToolExecuting(msg.id, msg.name, msg.input);
        } else if (msg.name === "TodoWrite") {
          tools.handleTodoWrite(msg.input);
        } else if (msg.name === "TaskCreate") {
          tools.handleTaskCreate(msg.input);
        } else if (msg.name === "TaskUpdate") {
          tools.handleTaskUpdate(msg.input);
        } else if (tools.getTodoTools()[msg.name]) {
          // TaskList, TaskGet - silently skip
        } else {
          var t = tools.getTools()[msg.id];
          if (t && t.hidden) break;
          tools.updateToolExecuting(msg.id, msg.name, msg.input);
        }
        break;

      case "tool_result": {
          if (!tools) break;
          var tr = tools.getTools()[msg.id];
          if (tr && tr.hidden) break;
          if (msg.content != null || msg.images || (tr && tr.name === "Edit" && tr.input && tr.input.old_string)) {
            tools.updateToolResult(msg.id, msg.content || "", msg.is_error || false, msg.images);
          }
          if (!msg.is_error && tr && (tr.name === "Edit" || tr.name === "Write") && tr.input && tr.input.file_path) {
            if (ctx.refreshIfOpen) ctx.refreshIfOpen(tr.input.file_path);
          }
        }
        break;

      case "ask_user_answered":
        if (tools) tools.markAskUserAnswered(msg.toolId);
        if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();
        break;

      case "permission_request":
        if (tools) tools.renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason);
        if (ctx.startUrgentBlink) ctx.startUrgentBlink();
        break;

      case "permission_cancel":
        if (tools) tools.markPermissionCancelled(msg.requestId);
        if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();
        break;

      case "permission_resolved":
        if (tools) tools.markPermissionResolved(msg.requestId, msg.decision);
        if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();
        break;

      case "permission_request_pending":
        if (tools) tools.renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason);
        if (ctx.startUrgentBlink) ctx.startUrgentBlink();
        break;

      case "elicitation_request":
        if (tools) tools.renderElicitationRequest(msg);
        if (ctx.startUrgentBlink) ctx.startUrgentBlink();
        break;

      case "elicitation_resolved":
        if (tools) tools.markElicitationResolved(msg.requestId, msg.action);
        if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();
        break;

      case "slash_command_result":
        finalizeAssistantBlock();
        var cmdBlock = document.createElement("div");
        cmdBlock.className = "assistant-block";
        cmdBlock.style.maxWidth = "var(--content-width)";
        cmdBlock.style.margin = "12px auto";
        cmdBlock.style.padding = "0 20px";
        var pre = document.createElement("pre");
        pre.style.cssText = "background:var(--code-bg);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:12px;line-height:1.55;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;margin:0";
        pre.textContent = msg.text;
        cmdBlock.appendChild(pre);
        addToMessages(cmdBlock);
        scrollToBottom();
        break;

      case "subagent_activity":
        if (tools) tools.updateSubagentActivity(msg.parentToolId, msg.text);
        break;

      case "subagent_tool":
        if (tools) tools.addSubagentToolEntry(msg.parentToolId, msg.toolName, msg.toolId, msg.text);
        break;

      case "subagent_done":
        if (tools) tools.markSubagentDone(msg.parentToolId, msg.status, msg.summary, msg.usage);
        break;

      case "task_started":
        if (tools) tools.initSubagentStop(msg.parentToolId, msg.taskId);
        break;

      case "task_progress":
        if (tools) tools.updateSubagentProgress(msg.parentToolId, msg.usage, msg.lastToolName, msg.summary);
        break;

      case "result":
        setActivity(null);
        if (tools) { tools.stopThinking(); tools.markAllToolsDone(); tools.closeToolGroup(); }
        finalizeAssistantBlock();
        if (tools) tools.addTurnMeta(msg.cost, msg.duration);
        accumulateUsage(msg.cost, msg.usage);
        accumulateContext(msg.cost, msg.usage, msg.modelUsage, msg.lastStreamInputTokens);
        break;

      case "done":
        setActivity(null);
        if (tools) { tools.stopThinking(); tools.markAllToolsDone(); tools.closeToolGroup(); }
        finalizeAssistantBlock();
        processing = false;
        setStatus("connected");
        if (!loopActive && ctx.enableMainInput) ctx.enableMainInput();
        if (tools) tools.resetToolState();
        if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();
        if (document.hidden) {
          if (ctx.isNotifAlertEnabled && ctx.isNotifAlertEnabled()) {
            if (ctx.showDoneNotification) ctx.showDoneNotification();
          }
          if (ctx.isNotifSoundEnabled && ctx.isNotifSoundEnabled()) {
            if (ctx.playDoneSound) ctx.playDoneSound();
          }
        }
        break;

      case "stderr":
        addSystemMessage(msg.text, false);
        break;

      case "error":
        setActivity(null);
        addSystemMessage(msg.text, true);
        break;

      case "process_conflict":
        setActivity(null);
        addConflictMessage(msg);
        break;

      case "context_overflow":
        setActivity(null);
        addContextOverflowMessage(msg);
        break;

      case "rate_limit":
        handleRateLimitEvent(msg);
        break;

      case "prompt_suggestion":
        showSuggestionChips(msg.suggestion);
        break;

      case "fast_mode_state":
        handleFastModeState(msg.state);
        break;

      case "process_killed":
        addSystemMessage("Process " + msg.pid + " has been terminated. You can retry your message now.", false);
        break;

      case "rewind_preview_result":
        if (ctx.showRewindModal) ctx.showRewindModal(msg);
        break;

      case "rewind_complete":
        if (ctx.setRewindMode) ctx.setRewindMode(false);
        var rewindText = "Rewound to earlier point. Files have been restored.";
        if (msg.mode === "chat") rewindText = "Conversation rewound to earlier point.";
        else if (msg.mode === "files") rewindText = "Files restored to earlier point.";
        addSystemMessage(rewindText, false);
        break;

      case "rewind_error":
        if (ctx.clearPendingRewindUuid) ctx.clearPendingRewindUuid();
        addSystemMessage(msg.text || "Rewind failed.", true);
        break;

      case "fork_complete":
        addSystemMessage("Session forked successfully.");
        break;

      // File system events
      case "fs_list_result":
        if (ctx.handleFsList) ctx.handleFsList(msg);
        break;
      case "fs_read_result":
        if (ctx.isProjectSettingsOpen && ctx.isProjectSettingsOpen() && msg.path === "CLAUDE.md") {
          if (ctx.handleInstructionsRead) ctx.handleInstructionsRead(msg);
        } else {
          if (ctx.handleFsRead) ctx.handleFsRead(msg);
        }
        break;
      case "fs_write_result":
        if (ctx.handleInstructionsWrite) ctx.handleInstructionsWrite(msg);
        break;
      case "fs_file_changed":
        if (ctx.handleFileChanged) ctx.handleFileChanged(msg);
        break;
      case "fs_dir_changed":
        if (ctx.handleDirChanged) ctx.handleDirChanged(msg);
        break;
      case "fs_file_history_result":
        if (ctx.handleFileHistory) ctx.handleFileHistory(msg);
        break;
      case "fs_git_diff_result":
        if (ctx.handleGitDiff) ctx.handleGitDiff(msg);
        break;
      case "fs_file_at_result":
        if (ctx.handleFileAt) ctx.handleFileAt(msg);
        break;

      // Terminal events
      case "term_list":
        if (ctx.handleTermList) ctx.handleTermList(msg);
        break;
      case "term_created":
        if (ctx.handleTermCreated) ctx.handleTermCreated(msg);
        break;
      case "term_output":
        if (ctx.handleTermOutput) ctx.handleTermOutput(msg);
        break;
      case "term_exited":
        if (ctx.handleTermExited) ctx.handleTermExited(msg);
        break;
      case "term_closed":
        if (ctx.handleTermClosed) ctx.handleTermClosed(msg);
        break;

      // Sticky notes events
      case "notes_list":
        if (ctx.handleNotesList) ctx.handleNotesList(msg);
        break;
      case "note_created":
        if (ctx.handleNoteCreated) ctx.handleNoteCreated(msg);
        break;
      case "note_updated":
        if (ctx.handleNoteUpdated) ctx.handleNoteUpdated(msg);
        break;
      case "note_deleted":
        if (ctx.handleNoteDeleted) ctx.handleNoteDeleted(msg);
        break;

      // --- Ralph Loop ---
      case "loop_available":
        loopAvailable = msg.available;
        loopActive = msg.active;
        loopIteration = msg.iteration || 0;
        loopMaxIterations = msg.maxIterations || 20;
        if (ctx.updateLoopButton) ctx.updateLoopButton();
        if (loopActive) {
          if (ctx.showLoopBanner) ctx.showLoopBanner(true);
          if (loopIteration > 0 && ctx.updateLoopBanner) {
            ctx.updateLoopBanner(loopIteration, loopMaxIterations, "running");
          }
          if (inputEl) {
            inputEl.disabled = true;
            inputEl.placeholder = "Ralph Loop is running...";
          }
        }
        break;

      case "loop_started":
        loopActive = true;
        ralphPhase = "executing";
        loopIteration = 0;
        loopMaxIterations = msg.maxIterations;
        if (ctx.showLoopBanner) ctx.showLoopBanner(true);
        if (ctx.updateLoopButton) ctx.updateLoopButton();
        addSystemMessage("Ralph Loop started (max " + msg.maxIterations + " iterations)", false);
        if (inputEl) {
          inputEl.disabled = true;
          inputEl.placeholder = "Ralph Loop is running...";
        }
        break;

      case "loop_iteration":
        loopIteration = msg.iteration;
        loopMaxIterations = msg.maxIterations;
        if (ctx.updateLoopBanner) ctx.updateLoopBanner(msg.iteration, msg.maxIterations, "running");
        if (ctx.updateLoopButton) ctx.updateLoopButton();
        addSystemMessage("Ralph Loop iteration #" + msg.iteration + " started", false);
        if (inputEl) {
          inputEl.disabled = true;
          inputEl.placeholder = "Ralph Loop is running...";
        }
        break;

      case "loop_judging":
        if (ctx.updateLoopBanner) ctx.updateLoopBanner(loopIteration, loopMaxIterations, "judging");
        addSystemMessage("Judging iteration #" + msg.iteration + "...", false);
        if (inputEl) {
          inputEl.disabled = true;
          inputEl.placeholder = "Ralph Loop is judging...";
        }
        break;

      case "loop_verdict":
        addSystemMessage("Judge: " + msg.verdict.toUpperCase() + " - " + (msg.summary || ""), false);
        break;

      case "loop_stopping":
        if (ctx.updateLoopBanner) ctx.updateLoopBanner(loopIteration, loopMaxIterations, "stopping");
        break;

      case "loop_finished":
        loopActive = false;
        ralphPhase = "done";
        if (ctx.showLoopBanner) ctx.showLoopBanner(false);
        if (ctx.updateLoopButton) ctx.updateLoopButton();
        if (ctx.enableMainInput) ctx.enableMainInput();
        var finishMsg = msg.reason === "pass"
          ? "Ralph Loop completed successfully after " + msg.iterations + " iteration(s)."
          : msg.reason === "max_iterations"
            ? "Ralph Loop reached maximum iterations (" + msg.iterations + ")."
            : msg.reason === "stopped"
              ? "Ralph Loop stopped."
              : "Ralph Loop ended with error.";
        addSystemMessage(finishMsg, false);
        break;

      case "loop_error":
        addSystemMessage("Ralph Loop error: " + msg.text, true);
        break;

      // --- Ralph Wizard / Crafting ---
      case "ralph_phase":
        ralphPhase = msg.phase || "idle";
        if (msg.craftingSessionId) ralphCraftingSessionId = msg.craftingSessionId;
        if (ctx.updateLoopButton) ctx.updateLoopButton();
        if (ctx.updateRalphBars) ctx.updateRalphBars();
        break;

      case "ralph_crafting_started":
        ralphPhase = "crafting";
        ralphCraftingSessionId = msg.sessionId || activeSessionId;
        if (ctx.updateLoopButton) ctx.updateLoopButton();
        if (ctx.updateRalphBars) ctx.updateRalphBars();
        if (msg.source !== "ralph" && ctx.enterCraftingMode) {
          ctx.enterCraftingMode(msg.sessionId, msg.taskId);
        }
        break;

      case "ralph_files_status":
        if (ctx.handleRalphFilesStatus) ctx.handleRalphFilesStatus(msg, ralphPhase);
        // Update local ralph state
        if (msg.bothReady && (ralphPhase === "crafting" || ralphPhase === "approval")) {
          ralphPhase = "approval";
        }
        break;

      case "loop_registry_files_content":
        if (ctx.handleLoopRegistryFiles) ctx.handleLoopRegistryFiles(msg);
        break;

      case "ralph_files_content":
        if (ctx.handleRalphFilesContent) ctx.handleRalphFilesContent(msg);
        break;

      case "loop_registry_error":
        addSystemMessage("Error: " + msg.text, true);
        break;
    }
  }

  // --- Public API ---
  return {
    // Core rendering
    setStatus: setStatus,
    setActivity: setActivity,
    addToMessages: addToMessages,
    scrollToBottom: scrollToBottom,
    forceScrollToBottom: forceScrollToBottom,
    addUserMessage: addUserMessage,
    ensureAssistantBlock: ensureAssistantBlock,
    addCopyHandler: addCopyHandler,
    appendDelta: appendDelta,
    drainStreamTick: drainStreamTick,
    flushStreamBuffer: flushStreamBuffer,
    finalizeAssistantBlock: finalizeAssistantBlock,
    addSystemMessage: addSystemMessage,
    addConflictMessage: addConflictMessage,
    addContextOverflowMessage: addContextOverflowMessage,

    // Usage/context
    accumulateUsage: accumulateUsage,
    resetUsage: resetUsage,
    updateUsagePanel: updateUsagePanel,
    toggleUsagePanel: toggleUsagePanel,
    accumulateContext: accumulateContext,
    resetContext: resetContext,
    resetContextData: resetContextData,
    updateContextPanel: updateContextPanel,
    toggleContextPanel: toggleContextPanel,
    getContextPercent: getContextPercent,

    // Session state
    resetClientState: resetClientState,
    hideSuggestionChips: hideSuggestionChips,
    showSuggestionChips: showSuggestionChips,

    // Rate limit / fast mode
    handleRateLimitEvent: handleRateLimitEvent,
    startRateLimitCountdown: startRateLimitCountdown,
    clearRateLimitIndicator: clearRateLimitIndicator,
    handleFastModeState: handleFastModeState,

    // History
    updateHistorySentinel: updateHistorySentinel,
    prependOlderHistory: prependOlderHistory,

    // Message processing
    processPaneMessage: processPaneMessage,

    // State getters
    get processing() { return processing; },
    get activeSessionId() { return activeSessionId; },
    set activeSessionId(v) { activeSessionId = v; },
    get turnCounter() { return turnCounter; },
    get messageUuidMap() { return messageUuidMap; },
    get loopActive() { return loopActive; },
    set loopActive(v) { loopActive = v; },
    get loopIteration() { return loopIteration; },
    get loopMaxIterations() { return loopMaxIterations; },
    get sessionDrafts() { return sessionDrafts; },
    get cliSessionId() { return cliSessionId; },
    set cliSessionId(v) { cliSessionId = v; },
    // Allow setting toolsSingleton after construction (for primary pane)
    toolsSingleton: null,
  };
}

// --- Singleton for primary pane ---
var _primary = null;

function initPaneRenderer(ctx) {
  _primary = createPaneRenderer(ctx);
  return _primary;
}

function getPrimaryRenderer() {
  return _primary;
}

export { createPaneRenderer, initPaneRenderer, getPrimaryRenderer };
