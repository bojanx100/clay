// app-debate-ui.js - Debate sticky banner, floor/conclude/ended modes, bottom bar, hand raise
// Extracted from app.js (PR-32)

import { refreshIcons, iconHtml } from './icons.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { scrollToBottom } from './app-rendering.js';
import { exportDebateAsPdf } from './debate.js';
import { showConfirm } from './confirm-modal.js';

// Module-internal UI vars (not in store)
var debateHandRaiseOpen = false;
// Local view of the pause state. Updated optimistically on click and
// corrected by every debate_pause_state message — so the button can never
// wedge in a state where clicking sends the same value forever.
var debatePausedLocal = false;

export function initDebateUi() {}

// --- Debate modes ---

export function showDebateConcludeConfirm(msg) {
  showDebateConcludeMode();
}

function showDebateConcludeMode() {
  removeDebateBottomBar();
  store.set({ debateConcludeMode: true });
  var inputArea = document.getElementById("input-area");
  if (inputArea) {
    inputArea.classList.add("debate-floor-mode");
    inputArea.style.display = "";
  }
  var existingBanner = document.getElementById("debate-floor-banner");
  if (existingBanner) existingBanner.remove();
  var banner = document.createElement("div");
  banner.id = "debate-floor-banner";
  banner.className = "debate-floor-banner";
  banner.innerHTML = iconHtml("check-circle") + " <span>The moderator is ready to conclude</span>" +
    '<button class="debate-floor-done-btn debate-floor-end-btn" id="debate-floor-end-btn">End Debate</button>';
  if (inputArea && inputArea.parentNode) {
    inputArea.parentNode.insertBefore(banner, inputArea);
  }
  refreshIcons();
  var endBtn = document.getElementById("debate-floor-end-btn");
  if (endBtn) {
    endBtn.addEventListener("click", function () {
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "debate_conclude_response", action: "end" }));
      }
      exitDebateConcludeMode();
    });
  }
  var inputEl = document.getElementById("input");
  if (inputEl) {
    inputEl._origPlaceholder = inputEl._origPlaceholder || inputEl.placeholder;
    inputEl.placeholder = "Add a direction to continue the debate...";
    inputEl.focus();
  }
  scrollToBottom();
}

export function exitDebateConcludeMode() {
  store.set({ debateConcludeMode: false });
  var inputArea = document.getElementById("input-area");
  if (inputArea) inputArea.classList.remove("debate-floor-mode");
  var banner = document.getElementById("debate-floor-banner");
  if (banner) banner.remove();
  var inputEl = document.getElementById("input");
  if (inputEl && inputEl._origPlaceholder) {
    inputEl.placeholder = inputEl._origPlaceholder;
    delete inputEl._origPlaceholder;
  }
}

export function handleDebateConcludeSend() {
  var text = document.getElementById("input").value.trim();
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "debate_conclude_response", action: "continue", text: text }));
  }
  document.getElementById("input").value = "";
  exitDebateConcludeMode();
  showDebateBottomBar("live");
}

export function showDebateEndedMode(msg) {
  removeDebateBottomBar();
  store.set({ debateEndedMode: true });
  var inputArea = document.getElementById("input-area");
  if (inputArea) {
    inputArea.classList.add("debate-floor-mode");
    inputArea.style.display = "";
  }
  var existingBanner = document.getElementById("debate-floor-banner");
  if (existingBanner) existingBanner.remove();
  var banner = document.createElement("div");
  banner.id = "debate-floor-banner";
  banner.className = "debate-floor-banner";
  banner.innerHTML = iconHtml("check-circle") + " <span>Debate ended — restart with the same brief?</span>" +
    '<button class="debate-floor-done-btn debate-floor-restart-btn" id="debate-ended-restart-btn">Restart with same brief</button>' +
    '<button class="debate-floor-done-btn" id="debate-ended-resume-btn">Resume</button>' +
    '<button class="debate-floor-done-btn" id="debate-ended-pdf-btn">' + iconHtml("download") + ' PDF</button>';
  if (inputArea && inputArea.parentNode) {
    inputArea.parentNode.insertBefore(banner, inputArea);
  }
  refreshIcons();
  var resumeBtn = document.getElementById("debate-ended-resume-btn");
  if (resumeBtn) {
    resumeBtn.addEventListener("click", function () {
      handleDebateEndedSend();
    });
  }
  var restartBtn = document.getElementById("debate-ended-restart-btn");
  if (restartBtn) {
    restartBtn.addEventListener("click", function () {
      var ws = getWs();
      if (!msg || !msg.topic || !msg.moderatorId || !msg.panelists || !msg.panelists.length) return;
      if (ws && ws.readyState === 1) {
        restartBtn.disabled = true;
        restartBtn.textContent = "Restarting…";
        ws.send(JSON.stringify({
          type: "debate_start",
          restartBrief: true,
          topic: msg.topic,
          format: msg.format || "free_discussion",
          context: msg.context || "",
          specialRequests: msg.specialRequests || null,
          moderatorId: msg.moderatorId,
          panelists: msg.panelists,
        }));
      }
    });
  }
  var pdfBtn = document.getElementById("debate-ended-pdf-btn");
  if (pdfBtn) {
    pdfBtn.addEventListener("click", function () {
      pdfBtn.disabled = true;
      exportDebateAsPdf().then(function () { pdfBtn.disabled = false; }).catch(function () { pdfBtn.disabled = false; });
    });
  }
  var inputEl2 = document.getElementById("input");
  if (inputEl2) {
    inputEl2._origPlaceholder = inputEl2._origPlaceholder || inputEl2.placeholder;
    inputEl2.placeholder = "Continue with a new direction...";
  }
  scrollToBottom();
}

export function exitDebateEndedMode() {
  store.set({ debateEndedMode: false });
  var inputArea = document.getElementById("input-area");
  if (inputArea) inputArea.classList.remove("debate-floor-mode");
  var banner = document.getElementById("debate-floor-banner");
  if (banner) banner.remove();
  var inputEl2 = document.getElementById("input");
  if (inputEl2 && inputEl2._origPlaceholder) {
    inputEl2.placeholder = inputEl2._origPlaceholder;
    delete inputEl2._origPlaceholder;
  }
}

function handleDebateEndedSend() {
  var text = document.getElementById("input").value.trim();
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "debate_conclude_response", action: "continue", text: text }));
  }
  document.getElementById("input").value = "";
  exitDebateEndedMode();
}

export function showDebateUserFloor(msg) {
  removeDebateBottomBar();
  store.set({ debateFloorMode: true });
  var inputArea = document.getElementById("input-area");
  if (inputArea) {
    inputArea.classList.add("debate-floor-mode");
    inputArea.style.display = "";
  }
  var existingBanner = document.getElementById("debate-floor-banner");
  if (existingBanner) existingBanner.remove();
  var banner = document.createElement("div");
  banner.id = "debate-floor-banner";
  banner.className = "debate-floor-banner";
  banner.innerHTML = iconHtml("mic") + " <span>You have the floor</span>" +
    '<button class="debate-floor-done-btn" id="debate-floor-done-btn">Pass</button>';
  if (inputArea && inputArea.parentNode) {
    inputArea.parentNode.insertBefore(banner, inputArea);
  }
  refreshIcons();
  var doneBtn = document.getElementById("debate-floor-done-btn");
  if (doneBtn) {
    doneBtn.addEventListener("click", function () {
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "debate_user_floor_response", text: "(The user passed without speaking)" }));
      }
      exitDebateFloorMode();
      showDebateBottomBar("live");
    });
  }
  var inputEl = document.getElementById("input");
  if (inputEl) {
    inputEl._origPlaceholder = inputEl.placeholder;
    inputEl.placeholder = "Share your thoughts with the panel...";
    inputEl.focus();
  }
  scrollToBottom();
}

export function exitDebateFloorMode() {
  store.set({ debateFloorMode: false });
  var inputArea = document.getElementById("input-area");
  if (inputArea) inputArea.classList.remove("debate-floor-mode");
  var banner = document.getElementById("debate-floor-banner");
  if (banner) banner.remove();
  var inputEl = document.getElementById("input");
  if (inputEl && inputEl._origPlaceholder) {
    inputEl.placeholder = inputEl._origPlaceholder;
    delete inputEl._origPlaceholder;
  }
}

export function handleDebateFloorSend() {
  var text = document.getElementById("input").value.trim();
  if (!text) return;
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "debate_user_floor_response", text: text }));
  }
  document.getElementById("input").value = "";
  exitDebateFloorMode();
  showDebateBottomBar("live");
}

export function renderDebateUserFloorDone(msg) {
  var messagesEl = document.getElementById("messages");
  if (!messagesEl) return;
  var el = document.createElement("div");
  el.className = "debate-user-comment";
  var label = document.createElement("span");
  label.className = "debate-comment-label";
  label.innerHTML = iconHtml("mic") + " User:";
  var textEl = document.createElement("div");
  textEl.className = "debate-comment-text";
  textEl.textContent = msg.text || "";
  el.appendChild(label);
  el.appendChild(textEl);
  messagesEl.appendChild(el);
  refreshIcons();
  scrollToBottom();
}

// --- Debate sticky banner ---

export function showDebateSticky(phase, msg) {
  if (phase === "ended" || phase === "hide") {
    store.set({ debateStickyState: null });
  } else {
    store.set({ debateStickyState: { phase: phase, msg: msg } });
  }

  var stickyEl = document.getElementById("debate-sticky");
  if (stickyEl) { stickyEl.classList.add("hidden"); stickyEl.innerHTML = ""; }

  var oldBadges = document.querySelectorAll(".debate-header-badge");
  for (var i = 0; i < oldBadges.length; i++) oldBadges[i].remove();

  if (phase === "ended" || phase === "hide") {
    debateHandRaiseOpen = false;
    removeDebateBottomBar();
    return;
  }

  if (phase === "live") {
    debateHandRaiseOpen = false;
    showDebateBottomBar("live");
  }

  var headerTitle = document.getElementById("header-title");
  if (!headerTitle) return;

  if (phase === "preparing") {
    var badge = document.createElement("span");
    badge.className = "debate-header-badge preparing";
    badge.textContent = "Setting up\u2026";
    headerTitle.after(badge);
  } else if (phase === "live") {
    var liveBadge = document.createElement("span");
    liveBadge.className = "debate-header-badge live";
    liveBadge.textContent = "Live";
    headerTitle.after(liveBadge);

    var roundBadge = document.createElement("span");
    roundBadge.className = "debate-header-badge round";
    roundBadge.id = "debate-header-round";
    roundBadge.textContent = "R" + ((msg && msg.round) || 1);
    liveBadge.after(roundBadge);
  }
}

// --- Debate bottom bar ---

export function showDebateBottomBar(mode, msg) {
  removeDebateBottomBar();

  var inputArea = document.getElementById("input-area");
  if (!inputArea || !inputArea.parentNode) return;

  var bar = document.createElement("div");
  bar.id = "debate-bottom-bar";
  bar.className = "debate-bottom-bar";

  if (mode === "live") {
    bar.innerHTML =
      '<div class="debate-bottom-inner">' +
        '<button class="debate-bottom-pause" id="debate-bottom-pause" title="Pause after the current speaker finishes — panelists hold until you resume">' + iconHtml("pause") + ' Pause</button>' +
        '<button class="debate-bottom-hand" id="debate-bottom-hand" title="Ask for the floor — you speak after the current speaker finishes">' + iconHtml("hand") + ' Raise hand</button>' +
        '<span class="debate-bottom-waiting hidden" id="debate-bottom-waiting">' + iconHtml("loader") + ' You will get the floor after the current speaker</span>' +
        '<button class="debate-bottom-stop" id="debate-bottom-stop" title="End the debate — panelists’ context is discarded">' + iconHtml("square") + ' End debate</button>' +
      '</div>';

    inputArea.parentNode.insertBefore(bar, inputArea);
    inputArea.style.display = "none";
    refreshIcons();

    if (debateHandRaiseOpen) {
      var handBtn = document.getElementById("debate-bottom-hand");
      var waitingEl = document.getElementById("debate-bottom-waiting");
      if (handBtn) { handBtn.classList.add("raised"); handBtn.classList.add("hidden"); }
      if (waitingEl) waitingEl.classList.remove("hidden");
    }

    document.getElementById("debate-bottom-hand").addEventListener("click", function () {
      toggleDebateHandRaise();
    });
    document.getElementById("debate-bottom-pause").addEventListener("click", function () {
      var wantPaused = !debatePausedLocal;
      var ws = getWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "debate_pause", paused: wantPaused }));
      }
      // Optimistic flip; the server's debate_pause_state ack corrects us.
      setDebatePauseState(wantPaused, false);
    });
    // Ending a live multi-agent debate is destructive and unrecoverable:
    // always confirm (F-8), never fire on a bare click.
    document.getElementById("debate-bottom-stop").addEventListener("click", function () {
      showConfirm(
        "End the debate? The panelists' context will be lost and the debate cannot be resumed.",
        function () {
          var ws = getWs();
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "debate_stop" }));
            var stopBtn = document.getElementById("debate-bottom-stop");
            if (stopBtn) {
              stopBtn.disabled = true;
              stopBtn.innerHTML = iconHtml("loader") + " Ending...";
              refreshIcons();
            }
            var waitingEl2 = document.getElementById("debate-bottom-waiting");
            if (waitingEl2) {
              waitingEl2.textContent = "Ending after current turn...";
              waitingEl2.classList.remove("hidden");
            }
          }
        },
        "End debate",
        true
      );
    });
  }
}

// Reflect server-confirmed pause state on the bottom bar (source of truth
// is the debate_pause_state message, not the local click).
export function setDebatePauseState(paused, holding) {
  debatePausedLocal = !!paused;
  var pauseBtn = document.getElementById("debate-bottom-pause");
  if (pauseBtn) {
    pauseBtn.classList.toggle("paused", !!paused);
    pauseBtn.innerHTML = paused
      ? iconHtml("play") + " Resume"
      : iconHtml("pause") + " Pause";
  }
  var waitingEl = document.getElementById("debate-bottom-waiting");
  if (waitingEl) {
    if (paused) {
      waitingEl.textContent = holding
        ? "Paused — panelists are holding. Press Resume to continue."
        : "Pausing — the current speaker will finish first.";
      waitingEl.classList.remove("hidden");
    } else if ((waitingEl.textContent || "").indexOf("Paus") === 0) {
      waitingEl.classList.add("hidden");
      waitingEl.textContent = "";
    }
  }
  refreshIcons();
}

export function debateAutoResize(textarea, maxRows) {
  textarea.style.height = "auto";
  var lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
  var maxHeight = lineHeight * maxRows;
  var newHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = newHeight + "px";
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function removeDebateBottomBar() {
  var existing = document.getElementById("debate-bottom-bar");
  if (existing) existing.remove();
  var handBar = document.getElementById("debate-hand-raise-bar");
  if (handBar) handBar.remove();
  debateHandRaiseOpen = false;
  var _ds = store.snap();
  if (_ds.debateFloorMode) exitDebateFloorMode();
  if (_ds.debateConcludeMode) exitDebateConcludeMode();
  if (_ds.debateEndedMode) exitDebateEndedMode();
  var inputArea = document.getElementById("input-area");
  if (inputArea) inputArea.style.display = "";
}

function toggleDebateHandRaise(forceState) {
  var raise = typeof forceState === "boolean" ? forceState : !debateHandRaiseOpen;
  debateHandRaiseOpen = raise;

  var handBtn = document.getElementById("debate-bottom-hand");
  var waitingEl = document.getElementById("debate-bottom-waiting");
  if (raise) {
    if (handBtn) { handBtn.classList.add("raised"); handBtn.classList.add("hidden"); }
    if (waitingEl) waitingEl.classList.remove("hidden");
  } else {
    if (handBtn) { handBtn.classList.remove("raised"); handBtn.classList.remove("hidden"); }
    if (waitingEl) waitingEl.classList.add("hidden");
  }

  var ws = getWs();
  if (raise && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "debate_hand_raise" }));
  }
}

export function sendDebateStickyComment() {
  var commentInput = document.getElementById("debate-sticky-comment");
  if (!commentInput) return;
  var text = commentInput.value.trim();
  if (!text) return;
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "debate_comment", text: text }));
  }
  toggleDebateHandRaise(false);
}

export function updateDebateRound(round) {
  var roundEl = document.getElementById("debate-header-round");
  if (roundEl) roundEl.textContent = "R" + round;
}
