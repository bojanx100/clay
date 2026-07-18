import { store } from './store.js';
import { renderMarkdown, highlightCodeBlocksChunked, renderMermaidBlocks } from './markdown.js';
import { markAllToolsDone, applyDeadSessionTodoCompaction, stopThinking } from './tools.js';
import { getPendingNavigate } from './filebrowser.js';
import { setActivity, stopUrgentBlink } from './app-favicon.js';
import { accumulateContext, updateContextPanel, updateUsagePanel } from './app-panels.js';
import { updateHistorySentinel, prependOlderHistory } from './app-header.js';
import { scrollToBottom, finalizeAssistantBlock, armStickyBottom, removeMatePreThinking } from './app-rendering.js';
import { exitDebateFloorMode, exitDebateConcludeMode, exitDebateEndedMode } from './app-debate-ui.js';
import { isDebateActive } from './debate.js';

var messagesEl = document.getElementById("messages");
var replayPerf = null;

export function handleHistoryMessage(msg) {
  switch (msg.type) {
    case "history_meta":
      store.set({ historyFrom: msg.from, historyTotal: msg.total, replayingHistory: true });
      replayPerf = { startedAt: (window.performance || Date).now(), total: msg.total, from: msg.from };
      updateHistorySentinel();
      return true;
    case "history_prepend":
      prependOlderHistory(msg.items, msg.meta);
      return true;
    case "history_done":
      handleHistoryDone(msg);
      return true;
    default:
      return false;
  }
}

function handleHistoryDone(msg) {
  store.set({ replayingHistory: false });
  if (messagesEl) {
    var now = (window.performance || Date).now.bind(window.performance || Date);
    var mermaidCount = messagesEl.querySelectorAll("pre code.language-mermaid").length;
    var replayStart = replayPerf ? replayPerf.startedAt : null;
    var replayTotal = replayPerf ? replayPerf.total : null;
    var highlightStart = now();
    highlightCodeBlocksChunked(messagesEl, {
      onDone: function (blockCount) {
        try {
          console.log(
            "[clay-perf] history replay: " +
            (replayTotal != null ? replayTotal : "?") + " items, " +
            blockCount + " code blocks, " + mermaidCount + " mermaid | " +
            "chunked-highlight=" + (now() - highlightStart).toFixed(0) + "ms (wall, yielding)" +
            (replayStart != null ? " total-since-meta=" + (now() - replayStart).toFixed(0) + "ms" : "")
          );
        } catch (e) {}
      },
    });
    renderMermaidBlocks(messagesEl);
    replayPerf = null;
  }
  if (!store.get('sessionIsProcessing')) {
    removeMatePreThinking();
    setActivity(null);
    stopThinking();
    applyDeadSessionTodoCompaction();
  }
  var historyTotal = store.get('historyTotal') || 0;
  var vendorToggleWrap = document.getElementById("vendor-toggle-wrap");
  if (vendorToggleWrap && historyTotal > 0 && !store.get('currentVendor')) {
    vendorToggleWrap.classList.remove("hidden");
    vendorToggleWrap.classList.add("locked");
  }
  if (msg.contextUsage) {
    store.set({ richContextUsage: msg.contextUsage });
  }
  if (msg.lastUsage || msg.lastModelUsage) {
    accumulateContext(msg.lastCost, msg.lastUsage, msg.lastModelUsage, msg.lastStreamInputTokens);
  }
  updateContextPanel();
  updateUsagePanel();
  var historyState = store.snap();
  if (historyState.currentMsgEl && historyState.currentFullText) {
    var replayContentEl = historyState.currentMsgEl.querySelector(".md-content");
    if (replayContentEl) {
      replayContentEl.innerHTML = renderMarkdown(historyState.currentFullText);
    }
  }
  markAllToolsDone();
  finalizeAssistantBlock();
  stopUrgentBlink();
  cleanupDebateUi();
  restoreHistoryScroll();
}

function cleanupDebateUi() {
  if (isDebateActive()) return;
  var debateBottomBar = document.getElementById("debate-bottom-bar");
  if (debateBottomBar) debateBottomBar.remove();
  var debateHandRaiseBar = document.getElementById("debate-hand-raise-bar");
  if (debateHandRaiseBar) debateHandRaiseBar.remove();
  var debateBadges = document.querySelectorAll(".debate-header-badge");
  for (var debateIndex = 0; debateIndex < debateBadges.length; debateIndex++) debateBadges[debateIndex].remove();
  var debateState = store.snap();
  if (debateState.debateFloorMode) exitDebateFloorMode();
  if (debateState.debateConcludeMode) exitDebateConcludeMode();
  if (debateState.debateEndedMode) exitDebateEndedMode();
  var debateBanner = document.getElementById("debate-floor-banner");
  if (debateBanner) debateBanner.remove();
}

function restoreHistoryScroll() {
  var nav = getPendingNavigate();
  var hasNavTarget = nav && (nav.toolId || nav.assistantUuid);
  if (hasNavTarget) {
    scrollToBottom();
  } else {
    armStickyBottom(750);
  }
  if (hasNavTarget) {
    requestAnimationFrame(function() {
      var target = nav.toolId ? messagesEl.querySelector('[data-tool-id="' + nav.toolId + '"]') : null;
      if (!target && nav.assistantUuid) {
        target = messagesEl.querySelector('[data-uuid="' + nav.assistantUuid + '"]');
      }
      if (target) {
        var parentGroup = target.closest(".tool-group");
        if (parentGroup) parentGroup.classList.remove("collapsed");
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("message-blink");
        setTimeout(function() { target.classList.remove("message-blink"); }, 2000);
      }
    });
  }
}
