import { copyToClipboard } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { renderMarkdown, highlightCodeBlocks, renderMermaidBlocks } from './markdown.js';

var ctx;
var deps = {};
var inPlanMode = false;
var planContent = null;
var currentPlanCardEl = null;

export function initPlanTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

function maybeScrollToBottom() {
  if (deps.maybeScrollToBottom) deps.maybeScrollToBottom();
}

function stopThinking() {
  if (deps.stopThinking) deps.stopThinking();
}

function closeToolGroup() {
  if (deps.closeToolGroup) deps.closeToolGroup();
}

export function renderPlanBanner(type) {
  ctx.finalizeAssistantBlock();
  stopThinking();
  closeToolGroup();

  var el = document.createElement("div");
  el.className = "plan-banner";

  if (type === "enter") {
    inPlanMode = true;
    planContent = null;
    currentPlanCardEl = null;
    el.innerHTML =
      '<span class="plan-banner-icon">' + iconHtml("map") + '</span>' +
      '<span class="plan-banner-text">Entered plan mode</span>' +
      '<span class="plan-banner-hint">Exploring codebase and designing implementation...</span>';
    el.classList.add("plan-enter");
  } else {
    inPlanMode = false;
    el.innerHTML =
      '<span class="plan-banner-icon">' + iconHtml("check-circle") + '</span>' +
      '<span class="plan-banner-text">Plan ready for review</span>';
    el.classList.add("plan-exit");
  }

  ctx.addToMessages(el);
  refreshIcons();
  maybeScrollToBottom();
  return el;
}

export function renderPlanCard(content) {
  ctx.finalizeAssistantBlock();
  closeToolGroup();
  planContent = content;

  var el = currentPlanCardEl && currentPlanCardEl.isConnected ? currentPlanCardEl : null;
  var header;
  var body;
  var isNew = !el;
  if (!el) {
    el = document.createElement("div");
    el.className = "plan-card";

    header = document.createElement("div");
    header.className = "plan-card-header";
    header.innerHTML =
      '<span class="plan-card-icon">' + iconHtml("file-text") + '</span>' +
      '<span class="plan-card-title">Implementation Plan</span>' +
      '<button class="plan-card-copy" title="Copy plan">' + iconHtml("copy") + '</button>' +
      '<span class="plan-card-chevron">' + iconHtml("chevron-down") + '</span>';

    body = document.createElement("div");
    body.className = "plan-card-body";

    header.addEventListener("click", function () {
      el.classList.toggle("collapsed");
    });

    el.appendChild(header);
    el.appendChild(body);
    ctx.addToMessages(el);
    currentPlanCardEl = el;
  } else {
    header = el.querySelector(".plan-card-header");
    body = el.querySelector(".plan-card-body");
  }

  body.innerHTML = renderMarkdown(content);
  highlightCodeBlocks(body);
  renderMermaidBlocks(body);

  var copyBtn = header.querySelector(".plan-card-copy");
  if (copyBtn) {
    copyBtn.onclick = function (e) {
      e.stopPropagation();
      copyToClipboard(content).then(function () {
        copyBtn.innerHTML = iconHtml("check");
        refreshIcons();
        setTimeout(function () {
          copyBtn.innerHTML = iconHtml("copy");
          refreshIcons();
        }, 1500);
      });
    };
  }

  refreshIcons();
  if (isNew) maybeScrollToBottom();
  return el;
}

export function isInPlanMode() {
  return inPlanMode;
}

export function getPlanContent() {
  return planContent;
}

export function setPlanContent(c) {
  planContent = c;
}

export function savePlanState() {
  return {
    inPlanMode: inPlanMode,
    planContent: planContent,
    currentPlanCardEl: currentPlanCardEl,
  };
}

export function restorePlanState(saved) {
  inPlanMode = saved.inPlanMode;
  planContent = saved.planContent;
  currentPlanCardEl = saved.currentPlanCardEl || null;
}

export function resetPlanState() {
  inPlanMode = false;
  planContent = null;
  currentPlanCardEl = null;
}
