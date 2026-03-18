import { refreshIcons, iconHtml } from './icons.js';

var NOTE_COLORS = ["yellow", "blue", "green", "pink", "orange", "purple"];
var ONBOARDING_KEY = "clay-sticky-notes-discovered";

var FORMAT_BUTTONS = [
  { label: "B", title: "Bold", cls: "sn-fmt-bold", command: "bold" },
  { label: "I", title: "Italic", cls: "sn-fmt-italic", command: "italic" },
  { label: "S", title: "Strikethrough", cls: "sn-fmt-strike", command: "strikethrough" },
  { label: "code-2", title: "Code", cls: "sn-fmt-code", command: "code", isIcon: true },
];

export function createStickyNotesInstance(_ctx) {
  var ctx = _ctx;
  var notes = new Map();
  var notesVisible = false;
  var archiveOpen = false;
  var updateTimers = {};
  var textTimers = {};
  var colorPickerEl = null;
  var formatToolbarEl = null;
  var onboardingEl = null;

  // --- Container bounds ---

  function getContainerBounds() {
    var c = document.querySelector(".pane-sticky-notes-container");
    if (!c || c.clientWidth === 0 || c.clientHeight === 0) return null;
    return { w: c.clientWidth, h: c.clientHeight };
  }

  function clampPos(x, y, noteW, noteH) {
    var b = getContainerBounds();
    if (!b) return { x: x, y: y };
    return {
      x: Math.max(0, Math.min(x, b.w - noteW)),
      y: Math.max(0, Math.min(y, b.h - noteH)),
    };
  }

  function clampSize(x, y, w, h) {
    var b = getContainerBounds();
    if (!b) return { w: w, h: h };
    return {
      w: Math.min(w, b.w - x),
      h: Math.min(h, b.h - y),
    };
  }

  function reclampAllNotes() {
    notes.forEach(function (entry) {
      var el = entry.el;
      var noteW = el.offsetWidth;
      var noteH = el.offsetHeight;
      var curX = parseInt(el.style.left) || 0;
      var curY = parseInt(el.style.top) || 0;
      var c = clampPos(curX, curY, noteW, noteH);
      el.style.left = c.x + "px";
      el.style.top = c.y + "px";
    });
  }

  // --- Onboarding beacon ---

  function maybeShowOnboarding() {
    try {
      if (localStorage.getItem(ONBOARDING_KEY)) return;
    } catch (e) { return; }

    var toggleBtn = document.querySelector(".pane-sticky-notes-toggle-btn");
    if (!toggleBtn) return;

    setTimeout(function () {
      if (notes.size > 0) {
        dismissOnboarding();
        return;
      }

      toggleBtn.classList.add("sn-onboarding-pulse");

      var tooltip = document.createElement("div");
      tooltip.className = "sn-onboarding-tooltip";
      tooltip.innerHTML = '<span>Click here to create a sticky note</span>';
      document.body.appendChild(tooltip);
      onboardingEl = tooltip;

      var rect = toggleBtn.getBoundingClientRect();
      tooltip.style.left = (rect.left + rect.width / 2) + "px";
      tooltip.style.top = (rect.bottom + 8) + "px";

      setTimeout(function () {
        dismissOnboarding();
      }, 8000);

      document.addEventListener("click", function onClickDismiss() {
        dismissOnboarding();
        document.removeEventListener("click", onClickDismiss);
      }, { once: true });
    }, 2000);
  }

  function dismissOnboarding() {
    var toggleBtn = document.querySelector(".pane-sticky-notes-toggle-btn");
    if (toggleBtn) toggleBtn.classList.remove("sn-onboarding-pulse");
    if (onboardingEl) {
      onboardingEl.classList.add("sn-onboarding-fade-out");
      var el = onboardingEl;
      setTimeout(function () { el.remove(); }, 300);
      onboardingEl = null;
    }
    try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch (e) {}
  }

  // --- Visibility ---

  function showNotes() {
    notesVisible = true;
    var container = document.querySelector(".pane-sticky-notes-container");
    var toggleBtn = document.querySelector(".pane-sticky-notes-toggle-btn");
    if (container) container.classList.remove("hidden");
    if (toggleBtn) toggleBtn.classList.add("active");
  }

  function hideNotes() {
    notesVisible = false;
    var container = document.querySelector(".pane-sticky-notes-container");
    var toggleBtn = document.querySelector(".pane-sticky-notes-toggle-btn");
    if (container) container.classList.add("hidden");
    if (toggleBtn) toggleBtn.classList.remove("active");
    closeColorPicker();
  }

  function createNote() {
    var container = document.querySelector(".pane-sticky-notes-container");
    if (!container) return;
    var offset = (notes.size % 5) * 30;
    wsSend({
      type: "note_create",
      x: 60 + offset,
      y: 60 + offset,
      color: "yellow",
    });
  }

  function updateBadge() {
    var badge = document.querySelector(".sticky-notes-count");
    if (!badge) return;
    if (notes.size > 0) {
      badge.textContent = notes.size;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  // --- WS send helpers ---

  function wsSend(obj) {
    if (ctx && ctx.ws && ctx.connected) {
      ctx.ws.send(JSON.stringify(obj));
    }
  }

  function debouncedUpdate(id, changes, delay) {
    clearTimeout(updateTimers[id]);
    updateTimers[id] = setTimeout(function () {
      changes.type = "note_update";
      changes.id = id;
      wsSend(changes);
    }, delay || 300);
  }

  function debouncedTextUpdate(id, text) {
    clearTimeout(textTimers[id]);
    textTimers[id] = setTimeout(function () {
      wsSend({ type: "note_update", id: id, text: text });
    }, 500);
  }

  // --- Simple markdown ---

  function getTitle(text) {
    if (!text) return "";
    var idx = text.indexOf("\n");
    return idx === -1 ? text : text.substring(0, idx);
  }

  function renderMiniMarkdown(text) {
    if (!text) return "";
    var lines = text.split("\n");
    var title = lines[0];
    var body = lines.slice(1).join("\n");

    function fmt(s) {
      var escaped = s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return escaped
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/~~(.+?)~~/g, "<del>$1</del>")
        .replace(/^- \[x\]/gm, '<span class="sn-check checked">✓</span>')
        .replace(/^- \[ \]/gm, '<span class="sn-check">☐</span>')
        .replace(/\n/g, "<br>");
    }

    var html = '<div class="sn-title">' + fmt(title) + '</div>';
    if (body.trim()) {
      html += fmt(body);
    }
    return html;
  }

  function syncTitle(noteEl, text) {
    var spacer = noteEl.querySelector(".sticky-note-spacer");
    if (spacer) spacer.textContent = getTitle(text);
  }

  // --- HTML-to-Markdown reverse conversion ---

  function nodeToMd(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return "";

    var tag = node.tagName;
    var inner = childrenToMd(node);

    switch (tag) {
      case "STRONG": case "B": return "**" + inner + "**";
      case "EM": case "I": return "*" + inner + "*";
      case "DEL": case "S": case "STRIKE": return "~~" + inner + "~~";
      case "CODE": return "`" + inner + "`";
      case "BR": return "\n";
      case "DIV":
        if (node.classList.contains("sn-title")) return inner;
        if (node.classList.contains("sn-placeholder")) return "";
        return "\n" + inner;
      case "P": return "\n" + inner;
      case "A": return node.getAttribute("href") || inner;
      case "SPAN":
        if (node.classList.contains("sn-check")) {
          return node.classList.contains("checked") ? "- [x]" : "- [ ]";
        }
        if (node.classList.contains("sn-placeholder")) return "";
        return inner;
      default: return inner;
    }
  }

  function childrenToMd(el) {
    var result = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      result += nodeToMd(el.childNodes[i]);
    }
    return result;
  }

  function extractMdFromRendered(rendered) {
    var titleEl = rendered.querySelector(".sn-title");
    if (titleEl) {
      var titleMd = childrenToMd(titleEl);
      var rest = "";
      var afterTitle = false;
      for (var i = 0; i < rendered.childNodes.length; i++) {
        var child = rendered.childNodes[i];
        if (child === titleEl) { afterTitle = true; continue; }
        if (afterTitle) rest += nodeToMd(child);
      }
      if (rest && rest.charAt(0) === "\n") rest = rest.substring(1);
      return titleMd + (rest ? "\n" + rest : "");
    }
    var md = childrenToMd(rendered);
    return md.replace(/^\n+/, "");
  }

  // --- Note rendering ---

  function renderNote(data) {
    var el = document.createElement("div");
    el.className = "sticky-note";
    el.dataset.noteId = data.id;
    var clamped = clampPos(data.x, data.y, data.w, data.h);
    el.style.left = clamped.x + "px";
    el.style.top = clamped.y + "px";
    el.style.width = data.w + "px";
    el.style.height = data.h + "px";
    el.style.zIndex = 100 + (data.zIndex || 0);
    el.dataset.color = data.color || "yellow";

    if (data.minimized) el.classList.add("minimized");
    if (data.hidden) el.classList.add("hidden");

    // Header
    var header = document.createElement("div");
    header.className = "sticky-note-header";

    var closeBtn = document.createElement("button");
    closeBtn.className = "sticky-note-btn sticky-note-close";
    closeBtn.title = "Close";
    closeBtn.innerHTML = iconHtml("x");
    header.appendChild(closeBtn);

    var minBtn = document.createElement("button");
    minBtn.className = "sticky-note-btn sticky-note-min-btn";
    minBtn.title = data.minimized ? "Expand" : "Minimize";
    minBtn.innerHTML = data.minimized ? iconHtml("maximize-2") : iconHtml("minus");
    header.appendChild(minBtn);

    var spacer = document.createElement("div");
    spacer.className = "sticky-note-spacer";
    spacer.textContent = getTitle(data.text);
    header.appendChild(spacer);

    var addBtn = document.createElement("button");
    addBtn.className = "sticky-note-btn";
    addBtn.title = "New note";
    addBtn.innerHTML = iconHtml("plus");
    addBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      createNote();
    });
    header.appendChild(addBtn);

    var colorBtn = document.createElement("button");
    colorBtn.className = "sticky-note-color-btn";
    colorBtn.title = "Change color";
    colorBtn.innerHTML = iconHtml("palette");
    header.appendChild(colorBtn);

    var mdBtn = document.createElement("button");
    mdBtn.className = "sticky-note-btn sticky-note-md-btn";
    mdBtn.title = "Edit markdown";
    mdBtn.innerHTML = "<span class='sn-md-label'>MD</span>";
    header.appendChild(mdBtn);

    el.appendChild(header);

    // Body
    var body = document.createElement("div");
    body.className = "sticky-note-body";

    var textarea = document.createElement("textarea");
    textarea.className = "sticky-note-text";
    textarea.value = data.text || "";
    textarea.style.display = "none";
    body.appendChild(textarea);

    var rendered = document.createElement("div");
    rendered.className = "sticky-note-rendered";
    rendered.contentEditable = "true";
    rendered.spellcheck = true;
    if (data.text && data.text.trim()) {
      rendered.innerHTML = renderMiniMarkdown(data.text);
    } else {
      rendered.classList.add("is-empty");
    }
    body.appendChild(rendered);

    el.appendChild(body);

    // Resize handle
    var resizeHandle = document.createElement("div");
    resizeHandle.className = "sticky-note-resize";
    el.appendChild(resizeHandle);

    // --- Event handlers ---
    setupDrag(el, spacer, data.id);
    setupResize(el, resizeHandle, data.id);
    setupTextEdit(textarea, rendered, data.id, mdBtn);
    setupColorPicker(colorBtn, el, data.id);
    setupMinimize(minBtn, el, data.id);
    setupClose(closeBtn, el, data.id);
    setupBringToFront(el, data.id);

    refreshIcons();
    return el;
  }

  // --- Drag ---

  function setupDrag(noteEl, spacerEl, noteId) {
    var dragging = false;
    var startX, startY, origX, origY;

    spacerEl.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origX = parseInt(noteEl.style.left) || 0;
      origY = parseInt(noteEl.style.top) || 0;
      noteEl.classList.add("dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    function onMove(e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var c = clampPos(origX + dx, origY + dy, noteEl.offsetWidth, noteEl.offsetHeight);
      noteEl.style.left = c.x + "px";
      noteEl.style.top = c.y + "px";
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      noteEl.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      debouncedUpdate(noteId, {
        x: parseInt(noteEl.style.left),
        y: parseInt(noteEl.style.top),
      }, 200);
    }

    // Touch support
    spacerEl.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) return;
      var touch = e.touches[0];
      dragging = true;
      startX = touch.clientX;
      startY = touch.clientY;
      origX = parseInt(noteEl.style.left) || 0;
      origY = parseInt(noteEl.style.top) || 0;
      noteEl.classList.add("dragging");
      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
    }, { passive: true });

    function onTouchMove(e) {
      if (!dragging) return;
      e.preventDefault();
      var touch = e.touches[0];
      var dx = touch.clientX - startX;
      var dy = touch.clientY - startY;
      var c = clampPos(origX + dx, origY + dy, noteEl.offsetWidth, noteEl.offsetHeight);
      noteEl.style.left = c.x + "px";
      noteEl.style.top = c.y + "px";
    }

    function onTouchEnd() {
      if (!dragging) return;
      dragging = false;
      noteEl.classList.remove("dragging");
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      debouncedUpdate(noteId, {
        x: parseInt(noteEl.style.left),
        y: parseInt(noteEl.style.top),
      }, 200);
    }
  }

  // --- Resize ---

  function setupResize(noteEl, handle, noteId) {
    var resizing = false;
    var startX, startY, origW, origH;
    var MIN_W = 160;
    var MIN_H = 80;

    handle.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      origW = noteEl.offsetWidth;
      origH = noteEl.offsetHeight;
      noteEl.classList.add("resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    function onMove(e) {
      if (!resizing) return;
      var rawW = Math.max(MIN_W, origW + (e.clientX - startX));
      var rawH = Math.max(MIN_H, origH + (e.clientY - startY));
      var cs = clampSize(parseInt(noteEl.style.left) || 0, parseInt(noteEl.style.top) || 0, rawW, rawH);
      noteEl.style.width = Math.max(MIN_W, cs.w) + "px";
      noteEl.style.height = Math.max(MIN_H, cs.h) + "px";
    }

    function onUp() {
      if (!resizing) return;
      resizing = false;
      noteEl.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      debouncedUpdate(noteId, {
        w: noteEl.offsetWidth,
        h: noteEl.offsetHeight,
      }, 200);
    }

    // Touch resize
    handle.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) return;
      e.stopPropagation();
      var touch = e.touches[0];
      resizing = true;
      startX = touch.clientX;
      startY = touch.clientY;
      origW = noteEl.offsetWidth;
      origH = noteEl.offsetHeight;
      noteEl.classList.add("resizing");
      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
    }, { passive: true });

    function onTouchMove(e) {
      if (!resizing) return;
      e.preventDefault();
      var touch = e.touches[0];
      var rawW = Math.max(MIN_W, origW + (touch.clientX - startX));
      var rawH = Math.max(MIN_H, origH + (touch.clientY - startY));
      var cs = clampSize(parseInt(noteEl.style.left) || 0, parseInt(noteEl.style.top) || 0, rawW, rawH);
      noteEl.style.width = Math.max(MIN_W, cs.w) + "px";
      noteEl.style.height = Math.max(MIN_H, cs.h) + "px";
    }

    function onTouchEnd() {
      if (!resizing) return;
      resizing = false;
      noteEl.classList.remove("resizing");
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      debouncedUpdate(noteId, {
        w: noteEl.offsetWidth,
        h: noteEl.offsetHeight,
      }, 200);
    }
  }

  // --- Text edit (contenteditable) ---

  // --- Format toolbar (WYSIWYG) ---

  function closeFormatToolbar() {
    if (formatToolbarEl) {
      formatToolbarEl.remove();
      formatToolbarEl = null;
    }
  }

  function applyFormat(command, rendered) {
    if (command === "code") {
      var sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return;
      var range = sel.getRangeAt(0);
      var ancestor = range.commonAncestorContainer;
      var codeParent = (ancestor.nodeType === 3 ? ancestor.parentElement : ancestor);
      if (codeParent && codeParent.closest && codeParent.closest("code")) {
        var codeEl = codeParent.closest("code");
        var textNode = document.createTextNode(codeEl.textContent);
        codeEl.parentNode.replaceChild(textNode, codeEl);
        var newRange = document.createRange();
        newRange.selectNodeContents(textNode);
        sel.removeAllRanges();
        sel.addRange(newRange);
      } else {
        var code = document.createElement("code");
        try { range.surroundContents(code); } catch (e) {
          var frag = range.extractContents();
          code.appendChild(frag);
          range.insertNode(code);
        }
      }
    } else {
      document.execCommand(command, false, null);
    }
    rendered.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function showFormatToolbar(rendered) {
    closeFormatToolbar();

    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    if (!sel.toString().trim()) return;

    var range = sel.getRangeAt(0);
    if (!rendered.contains(range.commonAncestorContainer)) return;

    var toolbar = document.createElement("div");
    toolbar.className = "sn-format-toolbar";

    for (var i = 0; i < FORMAT_BUTTONS.length; i++) {
      (function (cfg) {
        var btn = document.createElement("button");
        btn.className = "sn-fmt-btn " + cfg.cls;
        btn.title = cfg.title;
        btn.innerHTML = cfg.isIcon ? iconHtml(cfg.label) : cfg.label;
        btn.addEventListener("mousedown", function (e) {
          e.preventDefault();
          e.stopPropagation();
          applyFormat(cfg.command, rendered);
          setTimeout(function () {
            var s = window.getSelection();
            if (s && !s.isCollapsed) {
              showFormatToolbar(rendered);
            } else {
              closeFormatToolbar();
            }
          }, 0);
        });
        toolbar.appendChild(btn);
      })(FORMAT_BUTTONS[i]);
    }

    refreshIcons();
    document.body.appendChild(toolbar);
    formatToolbarEl = toolbar;
    positionToolbarAtRange(toolbar, range);
  }

  function positionToolbarAtRange(toolbar, range) {
    var rect = range.getBoundingClientRect();
    var toolbarX = rect.left + rect.width / 2;
    var toolbarY = rect.top - 4;

    toolbar.style.left = toolbarX + "px";
    toolbar.style.top = toolbarY + "px";

    requestAnimationFrame(function () {
      var tw = toolbar.offsetWidth;
      var th = toolbar.offsetHeight;
      var x = Math.max(8, Math.min(toolbarX - tw / 2, window.innerWidth - tw - 8));
      var y = Math.max(8, toolbarY - th);
      toolbar.style.left = x + "px";
      toolbar.style.top = y + "px";
    });
  }

  function setupTextEdit(textarea, rendered, noteId, mdBtn) {
    var noteEl = textarea.closest(".sticky-note");
    var mdMode = false;

    mdBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      mdMode = !mdMode;
      if (mdMode) {
        var md = extractMdFromRendered(rendered);
        textarea.value = md;
        textarea.style.display = "";
        rendered.style.display = "none";
        mdBtn.classList.add("active");
        textarea.focus();
      } else {
        var md = textarea.value;
        debouncedTextUpdate(noteId, md);
        syncTitle(noteEl, md);
        if (md.trim()) {
          rendered.innerHTML = renderMiniMarkdown(md);
          rendered.classList.remove("is-empty");
        } else {
          rendered.innerHTML = "";
          rendered.classList.add("is-empty");
        }
        textarea.style.display = "none";
        rendered.style.display = "";
        mdBtn.classList.remove("active");
        rendered.focus();
      }
    });

    rendered.addEventListener("input", function () {
      var md = extractMdFromRendered(rendered);
      textarea.value = md;
      debouncedTextUpdate(noteId, md);
      syncTitle(noteEl, md);
      rendered.classList.toggle("is-empty", !md.trim());
    });

    rendered.addEventListener("blur", function (e) {
      if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".sn-format-toolbar")) return;
      closeFormatToolbar();
      var md = extractMdFromRendered(rendered);
      textarea.value = md;
      if (md.trim()) {
        rendered.innerHTML = renderMiniMarkdown(md);
        rendered.classList.remove("is-empty");
      } else {
        rendered.innerHTML = "";
        rendered.classList.add("is-empty");
      }
    });

    rendered.addEventListener("mouseup", function (e) {
      if (e.target.tagName === "A") return;
      setTimeout(function () {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) {
          showFormatToolbar(rendered);
        } else {
          closeFormatToolbar();
        }
      }, 10);
    });

    rendered.addEventListener("keyup", function (e) {
      if (e.shiftKey || e.key === "Shift") {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          showFormatToolbar(rendered);
        } else {
          closeFormatToolbar();
        }
      }
    });

    rendered.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        document.execCommand("insertLineBreak");
      }
    });

    rendered.addEventListener("paste", function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, text);
    });

    rendered.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });

    textarea.addEventListener("input", function () {
      if (!mdMode) return;
      debouncedTextUpdate(noteId, textarea.value);
      syncTitle(noteEl, textarea.value);
    });

    textarea.addEventListener("mousedown", function (e) {
      e.stopPropagation();
    });
  }

  // --- Color picker ---

  function closeColorPicker() {
    if (colorPickerEl) {
      colorPickerEl.remove();
      colorPickerEl = null;
    }
  }

  function setupColorPicker(btn, noteEl, noteId) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      showColorPicker(btn, noteEl, noteId);
    });
  }

  function showColorPicker(anchor, noteEl, noteId) {
    closeColorPicker();

    var picker = document.createElement("div");
    picker.className = "sticky-note-color-picker";

    for (var i = 0; i < NOTE_COLORS.length; i++) {
      (function (color) {
        var dot = document.createElement("button");
        dot.className = "sticky-note-color-dot";
        dot.dataset.color = color;
        if (noteEl.dataset.color === color) dot.classList.add("active");
        dot.addEventListener("click", function (e) {
          e.stopPropagation();
          noteEl.dataset.color = color;
          wsSend({ type: "note_update", id: noteId, color: color });
          closeColorPicker();
        });
        picker.appendChild(dot);
      })(NOTE_COLORS[i]);
    }

    document.body.appendChild(picker);
    colorPickerEl = picker;

    var rect = anchor.getBoundingClientRect();
    picker.style.left = rect.left + "px";
    picker.style.top = (rect.bottom + 4) + "px";

    setTimeout(function () {
      document.addEventListener("click", function closeHandler() {
        closeColorPicker();
        document.removeEventListener("click", closeHandler);
      });
    }, 0);
  }

  // --- Minimize ---

  function setupMinimize(btn, noteEl, noteId) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var isMinimized = noteEl.classList.toggle("minimized");
      btn.innerHTML = isMinimized ? iconHtml("maximize-2") : iconHtml("minus");
      btn.title = isMinimized ? "Expand" : "Minimize";
      refreshIcons();
      wsSend({ type: "note_update", id: noteId, minimized: isMinimized });
    });
  }

  // --- Close (hide) note ---

  function setupClose(btn, noteEl, noteId) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      noteEl.classList.add("hidden");
      wsSend({ type: "note_update", id: noteId, hidden: true });
    });
  }

  // --- Bring to front ---

  function setupBringToFront(noteEl, noteId) {
    noteEl.addEventListener("mousedown", function (e) {
      if (e.target.closest("button")) return;
      wsSend({ type: "note_bring_front", id: noteId });
    });
  }

  // --- Sidebar badge ---

  function updateSidebarBadge() {
    var badge = document.getElementById("sticky-notes-sidebar-count");
    if (!badge) return;
    if (notes.size > 0) {
      badge.textContent = notes.size;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  // --- Notes Archive View ---

  function renderArchiveCards() {
    var grid = document.getElementById("notes-archive-grid");
    if (!grid) return;

    grid.innerHTML = "";

    if (notes.size === 0) {
      var empty = document.createElement("div");
      empty.className = "notes-archive-empty";
      empty.innerHTML = iconHtml("sticky-note") + "<p>No sticky notes yet</p><p class=\"notes-archive-empty-sub\">Create one with the " + iconHtml("sticky-note") + " button in the title bar</p>";
      grid.appendChild(empty);
      refreshIcons();
      return;
    }

    var sorted = Array.from(notes.values()).sort(function (a, b) {
      return (b.data.id || "").localeCompare(a.data.id || "");
    });

    for (var i = 0; i < sorted.length; i++) {
      (function (noteData) {
        var card = document.createElement("div");
        card.className = "notes-archive-card" + (noteData.data.hidden ? " archived" : "");
        card.dataset.color = noteData.data.color || "yellow";

        var header = document.createElement("div");
        header.className = "notes-archive-card-header";

        var title = document.createElement("div");
        title.className = "notes-archive-card-title";
        title.textContent = getTitle(noteData.data.text) || "Untitled";
        header.appendChild(title);

        var deleteBtn = document.createElement("button");
        deleteBtn.className = "notes-archive-card-delete";
        deleteBtn.title = "Delete permanently";
        deleteBtn.innerHTML = iconHtml("trash-2");
        deleteBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (card.classList.contains("confirm-delete")) {
            wsSend({ type: "note_delete", id: noteData.data.id });
            card.classList.add("deleting");
            return;
          }
          card.classList.add("confirm-delete");
          deleteBtn.title = "Click again to confirm";
          setTimeout(function () {
            card.classList.remove("confirm-delete");
            deleteBtn.title = "Delete permanently";
          }, 2000);
        });

        if (noteData.data.hidden) {
          var restoreBtn = document.createElement("button");
          restoreBtn.className = "notes-archive-card-restore";
          restoreBtn.title = "Restore to canvas";
          restoreBtn.innerHTML = iconHtml("rotate-ccw") + "<span>Restore</span>";
          restoreBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            wsSend({ type: "note_update", id: noteData.data.id, hidden: false });
            noteData.el.classList.remove("hidden");
            noteData.data.hidden = false;
            renderArchiveCards();
          });
          header.appendChild(restoreBtn);
        }

        header.appendChild(deleteBtn);
        card.appendChild(header);

        var body = document.createElement("div");
        body.className = "notes-archive-card-body";
        var bodyLines = (noteData.data.text || "").split("\n").slice(1).join("\n").trim();
        if (bodyLines) {
          body.innerHTML = renderMiniMarkdown("_\n" + bodyLines).replace('<div class="sn-title">_</div>', "");
        }
        card.appendChild(body);

        var colorStrip = document.createElement("div");
        colorStrip.className = "notes-archive-card-color";
        card.appendChild(colorStrip);

        card.addEventListener("click", function () {
          closeArchive();
          showNotes();
          if (noteData.data.hidden) {
            wsSend({ type: "note_update", id: noteData.data.id, hidden: false });
            noteData.el.classList.remove("hidden");
          }
          wsSend({ type: "note_bring_front", id: noteData.data.id });
          if (noteData.data.minimized) {
            wsSend({ type: "note_update", id: noteData.data.id, minimized: false });
          }
          var noteEl = noteData.el;
          if (noteEl) {
            noteEl.classList.add("note-flash");
            setTimeout(function () { noteEl.classList.remove("note-flash"); }, 600);
          }
        });

        grid.appendChild(card);
      })(sorted[i]);
    }

    refreshIcons();
  }

  function openArchive() {
    if (archiveOpen) return;
    archiveOpen = true;

    var messagesEl = document.querySelector(".pane-messages");
    var appEl = document.querySelector(".pane-app");
    var inputArea = document.querySelector(".pane-input-area");
    var titleBar = document.querySelector(".pane > .title-bar-content");
    var notesContainer = document.querySelector(".pane-sticky-notes-container");

    if (messagesEl) messagesEl.classList.add("hidden");
    if (inputArea) inputArea.classList.add("hidden");
    if (titleBar) titleBar.classList.add("hidden");
    if (notesContainer) notesContainer.classList.add("hidden");

    var archive = document.getElementById("notes-archive");
    if (!archive) {
      archive = document.createElement("div");
      archive.id = "notes-archive";

      var header = document.createElement("div");
      header.className = "notes-archive-header";

      var titleWrap = document.createElement("div");
      titleWrap.className = "notes-archive-title-wrap";
      titleWrap.innerHTML = iconHtml("sticky-note") + "<h2>Sticky Notes</h2><span class=\"notes-archive-count\"></span>";
      header.appendChild(titleWrap);

      var closeBtn = document.createElement("button");
      closeBtn.className = "notes-archive-close";
      closeBtn.title = "Back to chat";
      closeBtn.innerHTML = iconHtml("x");
      closeBtn.addEventListener("click", function () {
        closeArchive();
      });
      header.appendChild(closeBtn);

      archive.appendChild(header);

      var grid = document.createElement("div");
      grid.id = "notes-archive-grid";
      grid.className = "notes-archive-grid";
      archive.appendChild(grid);

      if (appEl) appEl.appendChild(archive);
    }

    archive.classList.remove("hidden");

    var countEl = archive.querySelector(".notes-archive-count");
    if (countEl) countEl.textContent = notes.size + " note" + (notes.size !== 1 ? "s" : "");

    renderArchiveCards();

    var sidebarBtn = document.getElementById("sticky-notes-sidebar-btn");
    if (sidebarBtn) sidebarBtn.classList.add("active");

    refreshIcons();
  }

  function closeArchive() {
    if (!archiveOpen) return;
    archiveOpen = false;

    var archive = document.getElementById("notes-archive");
    var messagesEl = document.querySelector(".pane-messages");
    var inputArea = document.querySelector(".pane-input-area");
    var titleBar = document.querySelector(".pane > .title-bar-content");
    var notesContainer = document.querySelector(".pane-sticky-notes-container");

    if (archive) archive.classList.add("hidden");
    if (messagesEl) messagesEl.classList.remove("hidden");
    if (inputArea) inputArea.classList.remove("hidden");
    if (titleBar) titleBar.classList.remove("hidden");

    if (notesContainer && notesVisible) notesContainer.classList.remove("hidden");

    var sidebarBtn = document.getElementById("sticky-notes-sidebar-btn");
    if (sidebarBtn) sidebarBtn.classList.remove("active");
  }

  function isArchiveOpen() {
    return archiveOpen;
  }

  // --- WS message handlers ---

  function handleNotesList(msg) {
    var container = document.querySelector(".pane-sticky-notes-container");
    if (!container) return;

    container.innerHTML = "";
    notes.clear();

    var list = msg.notes || [];
    for (var i = 0; i < list.length; i++) {
      var el = renderNote(list[i]);
      notes.set(list[i].id, { data: list[i], el: el });
      container.appendChild(el);
    }

    updateBadge();
    updateSidebarBadge();

    if (list.length > 0) dismissOnboarding();

    if (list.length > 0 && !notesVisible) {
      notesVisible = true;
      container.classList.remove("hidden");
      var toggleBtn = document.querySelector(".pane-sticky-notes-toggle-btn");
      if (toggleBtn) toggleBtn.classList.add("active");
    }
  }

  function handleNoteCreated(msg) {
    var container = document.querySelector(".pane-sticky-notes-container");
    if (!container || !msg.note) return;

    if (notes.has(msg.note.id)) return;

    var el = renderNote(msg.note);
    notes.set(msg.note.id, { data: msg.note, el: el });
    container.appendChild(el);
    updateBadge();
    updateSidebarBadge();

    if (archiveOpen) renderArchiveCards();

    if (!notesVisible) {
      notesVisible = true;
      container.classList.remove("hidden");
      var toggleBtn = document.querySelector(".pane-sticky-notes-toggle-btn");
      if (toggleBtn) toggleBtn.classList.add("active");
    }
  }

  function handleNoteUpdated(msg) {
    if (!msg.note) return;
    var entry = notes.get(msg.note.id);
    if (!entry) return;

    entry.data = msg.note;

    entry.el.style.left = msg.note.x + "px";
    entry.el.style.top = msg.note.y + "px";
    entry.el.style.width = msg.note.w + "px";
    entry.el.style.height = msg.note.h + "px";
    entry.el.style.zIndex = 100 + (msg.note.zIndex || 0);
    entry.el.dataset.color = msg.note.color || "yellow";

    var textarea = entry.el.querySelector(".sticky-note-text");
    var rendered = entry.el.querySelector(".sticky-note-rendered");
    if (rendered && rendered !== document.activeElement && textarea !== document.activeElement) {
      if (textarea) textarea.value = msg.note.text || "";
      if (msg.note.text && msg.note.text.trim()) {
        rendered.innerHTML = renderMiniMarkdown(msg.note.text);
        rendered.classList.remove("is-empty");
      } else {
        rendered.innerHTML = "";
        rendered.classList.add("is-empty");
      }
      syncTitle(entry.el, msg.note.text);
    }

    if (msg.note.hidden) {
      entry.el.classList.add("hidden");
    } else {
      entry.el.classList.remove("hidden");
    }

    var minBtn = entry.el.querySelector(".sticky-note-min-btn");
    if (msg.note.minimized) {
      entry.el.classList.add("minimized");
      if (minBtn) { minBtn.innerHTML = iconHtml("maximize-2"); minBtn.title = "Expand"; }
    } else {
      entry.el.classList.remove("minimized");
      if (minBtn) { minBtn.innerHTML = iconHtml("minus"); minBtn.title = "Minimize"; }
    }
    refreshIcons();

    if (archiveOpen) renderArchiveCards();
  }

  function handleNoteDeleted(msg) {
    var entry = notes.get(msg.id);
    if (!entry) return;
    entry.el.remove();
    notes.delete(msg.id);
    updateBadge();
    updateSidebarBadge();

    clearTimeout(updateTimers[msg.id]);
    clearTimeout(textTimers[msg.id]);
    delete updateTimers[msg.id];
    delete textTimers[msg.id];

    if (archiveOpen) renderArchiveCards();
  }

  // --- Initialization (event listeners) ---

  var toggleBtn = document.querySelector(".pane-sticky-notes-toggle-btn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      dismissOnboarding();
      if (!notesVisible && notes.size > 0) {
        showNotes();
      } else {
        showNotes();
        createNote();
      }
    });

    toggleBtn.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      if (notesVisible) hideNotes();
    });
  }

  document.addEventListener("mousedown", function (e) {
    if (formatToolbarEl && !e.target.closest(".sn-format-toolbar") && !e.target.closest(".sticky-note-text") && !e.target.closest(".sticky-note-rendered")) {
      closeFormatToolbar();
    }
  });

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (notesVisible && notes.size > 0) {
        reclampAllNotes();
      }
    }, 100);
  });

  maybeShowOnboarding();

  // --- Return public API ---

  return {
    handleNotesList: handleNotesList,
    handleNoteCreated: handleNoteCreated,
    handleNoteUpdated: handleNoteUpdated,
    handleNoteDeleted: handleNoteDeleted,
    openArchive: openArchive,
    closeArchive: closeArchive,
    isArchiveOpen: isArchiveOpen,
  };
}

// --- Backward-compat singleton delegates ---

var _primary = null;

export function initStickyNotes(_ctx) {
  _primary = createStickyNotesInstance(_ctx);
}

export function handleNotesList(msg) { return _primary.handleNotesList(msg); }
export function handleNoteCreated(msg) { return _primary.handleNoteCreated(msg); }
export function handleNoteUpdated(msg) { return _primary.handleNoteUpdated(msg); }
export function handleNoteDeleted(msg) { return _primary.handleNoteDeleted(msg); }
export function openArchive() { return _primary.openArchive(); }
export function closeArchive() { return _primary.closeArchive(); }
export function isArchiveOpen() { return _primary.isArchiveOpen(); }
