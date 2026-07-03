import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';

var ctx;
var deps = {};
var currentThinking = null;
var thinkingGroup = null;

export function initThinkingTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

function maybeScrollToBottom() {
  if (deps.maybeScrollToBottom) deps.maybeScrollToBottom();
}

export function updateThinkingTokens(estimatedTokens) {
  if (!currentThinking || !currentThinking.el) return;
  var label = currentThinking.el.querySelector(".thinking-label");
  if (!label) return;
  var n = estimatedTokens || 0;
  var disp = n >= 1000 ? ("~" + (Math.round(n / 100) / 10) + "k") : ("~" + n);
  label.textContent = "Thinking " + disp + " tokens";
}

export function startThinking() {
  ctx.finalizeAssistantBlock();

  if (thinkingGroup && thinkingGroup.el.classList.contains("done")) {
    var reusedEl = thinkingGroup.el;
    reusedEl.classList.remove("done");
    reusedEl.querySelector(".thinking-content").textContent = "";
    var reuseLabel = reusedEl.querySelector(".thinking-label");
    if (reuseLabel) reuseLabel.textContent = "Thinking";
    if (reusedEl.classList.contains("mate-thinking")) {
      var actRow = reusedEl.querySelector(".mate-thinking-activity");
      if (actRow) {
        actRow.style.display = "";
      }
      var reusedHeader = reusedEl.querySelector(".thinking-header");
      if (reusedHeader) reusedHeader.style.display = "none";
    }
    currentThinking = { el: reusedEl, fullText: "", startTime: Date.now() };
    refreshIcons();
    maybeScrollToBottom();
    if (!reusedEl.classList.contains("mate-thinking")) {
      ctx.setActivity("thinking");
    }
    return;
  }

  var el = document.createElement("div");
  el.className = "thinking-item";

  if (ctx.isMateDm()) {
    var mateName = ctx.getMateName();
    var mateAvatar = ctx.getMateAvatarUrl();
    el.classList.add("mate-thinking");
    el.innerHTML =
      '<img class="dm-bubble-avatar dm-bubble-avatar-mate" src="' + escapeHtml(mateAvatar) + '" alt="">' +
      '<div class="dm-bubble-content">' +
      '<div class="dm-bubble-header"><span class="dm-bubble-name">' + escapeHtml(mateName) + '</span></div>' +
      '<div class="mate-thinking-dots mate-thinking-activity"><span></span><span></span><span></span></div>' +
      '<div class="thinking-header" style="display:none">' +
      '<span class="thinking-chevron">' + iconHtml("chevron-right") + '</span>' +
      '<span class="thinking-label">Thinking</span>' +
      '<span class="thinking-duration"></span>' +
      '<span class="thinking-spinner">' + iconHtml("loader", "icon-spin") + '</span>' +
      '</div>' +
      '<div class="thinking-content"></div>' +
      '</div>';
  } else {
    el.innerHTML =
      '<div class="thinking-header">' +
      '<span class="thinking-chevron">' + iconHtml("chevron-right") + '</span>' +
      '<span class="thinking-label">Thinking</span>' +
      '<span class="thinking-duration"></span>' +
      '<span class="thinking-spinner">' + iconHtml("loader", "icon-spin") + '</span>' +
      '</div>' +
      '<div class="thinking-content"></div>';
  }

  el.querySelector(".thinking-header").addEventListener("click", function () {
    el.classList.toggle("expanded");
  });

  ctx.addToMessages(el);
  refreshIcons();
  maybeScrollToBottom();
  thinkingGroup = { el: el, count: 0, totalDuration: 0 };
  currentThinking = { el: el, fullText: "", startTime: Date.now() };
  if (!ctx.isMateDm()) {
    ctx.setActivity("thinking");
  }
}

export function appendThinking(text) {
  if (!currentThinking) return;
  currentThinking.fullText += text;
  currentThinking.el.querySelector(".thinking-content").textContent = currentThinking.fullText;
  maybeScrollToBottom();
}

export function stopThinking(duration) {
  if (!currentThinking) return;
  var secs = typeof duration === "number" ? duration : (Date.now() - currentThinking.startTime) / 1000;
  currentThinking.el.classList.add("done");
  if (thinkingGroup && thinkingGroup.el === currentThinking.el) {
    thinkingGroup.count++;
    thinkingGroup.totalDuration += secs;
    currentThinking.el.querySelector(".thinking-duration").textContent = " " + thinkingGroup.totalDuration.toFixed(1) + "s";
  } else {
    currentThinking.el.querySelector(".thinking-duration").textContent = " " + secs.toFixed(1) + "s";
  }
  var hasContent = !!(currentThinking.fullText && currentThinking.fullText.length > 0);
  if (!hasContent) {
    currentThinking.el.classList.add("empty");
    var chev = currentThinking.el.querySelector(".thinking-chevron");
    if (chev) chev.style.display = "none";
    var hdr = currentThinking.el.querySelector(".thinking-header");
    if (hdr) {
      hdr.style.cursor = "default";
      var clone = hdr.cloneNode(true);
      hdr.parentNode.replaceChild(clone, hdr);
    }
  }
  if (currentThinking.el.classList.contains("mate-thinking")) {
    var actRow = currentThinking.el.querySelector(".mate-thinking-activity");
    if (actRow) actRow.style.display = "none";
    var header = currentThinking.el.querySelector(".thinking-header");
    if (header) {
      header.style.display = "";
      header.style.cursor = hasContent ? "pointer" : "default";
    }
  }
  currentThinking = null;
}

export function resetThinkingGroup() {
  thinkingGroup = null;
}

export function saveThinkingState() {
  return {
    currentThinking: currentThinking,
  };
}

export function restoreThinkingState(saved) {
  currentThinking = saved.currentThinking;
}

export function resetThinkingState() {
  currentThinking = null;
  thinkingGroup = null;
}
