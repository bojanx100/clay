import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { sendUserAction } from './app-connection.js';
import { escapeHtml, showToast } from './utils.js';

var HEARTBEAT_MS = 10000;
var THINKING_GRACE_MS = 5 * 60 * 1000;
var SIGNAL_THROTTLE_MS = 1500;
var state = null;
var wrap = null;
var chip = null;
var chipText = null;
var popover = null;
var lastInteractionAt = 0;
var lastSignalAt = 0;
var pendingExplicit = false;
var heartbeatTimer = null;
var repaintTimer = null;
var mobileAttentionClient = null;

function pageVisible() {
  return document.hidden !== true;
}

function pageFocused() {
  if (typeof document.hasFocus !== "function") return true;
  return document.hasFocus();
}

export function isMobileAttentionClient(navigatorValue) {
  var nav = navigatorValue || {};
  var userAgent = nav.userAgent || "";
  if (/Mobi|Android|iPad|iPhone|iPod/.test(userAgent)) return true;
  return nav.platform === "MacIntel" && Number(nav.maxTouchPoints || 0) > 1;
}

function usesMobileForegroundMode() {
  if (mobileAttentionClient === null) {
    mobileAttentionClient = isMobileAttentionClient(
      typeof navigator === "undefined" ? null : navigator);
  }
  return mobileAttentionClient;
}

function formatDuration(durationMs) {
  var minutes = Math.max(0, Math.floor(Number(durationMs || 0) / 60000));
  if (minutes < 60) return minutes + "m";
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  return rest ? hours + "h " + rest + "m" : hours + "h";
}

export function trackingCoverageLabel(attentionState, formatTime) {
  if (!attentionState || attentionState.partialToday !== true) {
    return "5am–5am · all Clay devices";
  }
  if (attentionState.recordingStartExact === true && attentionState.recordingStartedAt > 0) {
    var formatter = typeof formatTime === "function" ? formatTime : function (timestamp) {
      return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    };
    return "Partial day · tracking since " + formatter(attentionState.recordingStartedAt) +
      " · all Clay devices";
  }
  return "Partial day · earlier time unavailable · all Clay devices";
}

function projectedTodayMs() {
  if (!state) return 0;
  var extra = state.tracking ? Math.min(25000, Math.max(0, Date.now() - state.measuredAt)) : 0;
  return state.todayMs + extra;
}

export function handleAttentionDismissEvent(event, dismiss) {
  var isPointer = event && event.type === "pointerdown";
  var isActivation = event && event.type === "click";
  var isEscape = event && event.type === "keydown" && event.key === "Escape";
  if (!isPointer && !isActivation && !isEscape) return false;
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopPropagation === "function") event.stopPropagation();
  if (typeof dismiss === "function") dismiss();
  return true;
}

export function buildAttentionSignalPayload(now, visible, focused, interactedAt, explicit, offset,
    mobileClient) {
  var mobileForeground = mobileClient === true && visible;
  var engaged = interactedAt > 0 && (mobileForeground ||
    (visible && focused && now - interactedAt <= THINKING_GRACE_MS));
  var payload = {
    type: "human_attention_signal",
    visible: visible,
    focused: focused,
    engaged: engaged,
    interaction: explicit === true && engaged,
    timezoneOffsetMinutes: offset,
  };
  if (mobileForeground) payload.mobileForeground = true;
  return payload;
}

function sendSignal(explicit) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !store.get('connected')) return false;
  var now = Date.now();
  var visible = pageVisible();
  var focused = pageFocused();
  var payload = buildAttentionSignalPayload(now, visible, focused,
    lastInteractionAt, explicit, new Date().getTimezoneOffset(), usesMobileForegroundMode());
  try {
    ws.send(JSON.stringify(payload));
    lastSignalAt = now;
    if (payload.interaction) pendingExplicit = false;
    return true;
  } catch (e) {
    return false;
  }
}

function noteInteraction() {
  if (!pageVisible()) return;
  lastInteractionAt = Date.now();
  pendingExplicit = true;
  if (lastInteractionAt - lastSignalAt >= SIGNAL_THROTTLE_MS) sendSignal(true);
}

function sendInactive() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !store.get('connected')) return;
  try {
    ws.send(JSON.stringify({
      type: "human_attention_signal",
      visible: pageVisible(),
      focused: pageFocused(),
      engaged: false,
      interaction: false,
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    }));
  } catch (e) {}
}

function renderChip() {
  if (!state || !wrap || !chip || !chipText) return;
  var todayMs = projectedTodayMs();
  var capMs = state.capMinutes * 60000;
  var ratio = capMs ? todayMs / capMs : 0;
  wrap.classList.remove("hidden");
  chip.classList.toggle("warning", ratio >= 0.8 && ratio < 1);
  chip.classList.toggle("reached", ratio >= 1);
  chipText.textContent = formatDuration(todayMs) + " / " + formatDuration(capMs);
  chip.title = "Human work today: " + formatDuration(todayMs) + " of " + formatDuration(capMs);
}

function dayLabel(key, index) {
  if (index === 0) return "Today";
  if (index === 1) return "Yesterday";
  var date = new Date(key + "T12:00:00");
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function renderProjectRows(rows) {
  var recorded = [];
  for (var r = 0; rows && r < rows.length; r++) {
    if (Number(rows[r].durationMs || 0) >= 60000) recorded.push(rows[r]);
  }
  if (!recorded.length) return '<div class="human-attention-empty">No recorded time</div>';
  var html = "";
  for (var i = 0; i < recorded.length; i++) {
    html += '<div class="human-attention-row"><span>' + escapeHtml(recorded[i].projectSlug) +
      '</span><strong>' + formatDuration(recorded[i].durationMs) + '</strong></div>';
  }
  return html;
}

function renderPopover() {
  if (!state || !popover) return;
  var todayMs = projectedTodayMs();
  var capMs = state.capMinutes * 60000;
  var percent = capMs ? Math.min(100, Math.round(todayMs / capMs * 100)) : 0;
  var todayProjects = state.days && state.days[0] ? state.days[0].projects : [];
  var daysHtml = "";
  for (var i = 0; i < state.days.length; i++) {
    var dayPercent = capMs ? Math.min(100, Math.round(state.days[i].totalMs / capMs * 100)) : 0;
    daysHtml += '<div class="human-attention-day"><span class="human-attention-day-label">' +
      escapeHtml(dayLabel(state.days[i].key, i)) + '</span><span class="human-attention-day-meter" aria-hidden="true">' +
      '<span style="width:' + dayPercent + '%"></span></span><strong>' +
      formatDuration(state.days[i].totalMs) + '</strong></div>';
  }
  popover.querySelector("#human-attention-today").textContent = formatDuration(todayMs);
  popover.querySelector("#human-attention-coverage").textContent = trackingCoverageLabel(state);
  popover.querySelector("#human-attention-remaining").textContent =
    todayMs >= capMs ? "Cap reached" : formatDuration(capMs - todayMs);
  popover.querySelector("#human-attention-budget-label").textContent = "of " + formatDuration(capMs);
  popover.querySelector("#human-attention-total").textContent = formatDuration(state.totalMs);
  popover.querySelector("#human-attention-project-today").textContent = formatDuration(state.projectTodayMs);
  var progress = popover.querySelector("#human-attention-progress");
  progress.setAttribute("aria-valuenow", String(percent));
  progress.setAttribute("aria-valuetext", formatDuration(todayMs) + " of " + formatDuration(capMs));
  popover.querySelector("#human-attention-progress-fill").style.width = percent + "%";
  popover.querySelector("#human-attention-cap-hours").value = String(state.capMinutes / 60);
  popover.querySelector("#human-attention-projects").innerHTML = renderProjectRows(todayProjects);
  popover.querySelector("#human-attention-project-totals").innerHTML = renderProjectRows(state.projects);
  popover.querySelector("#human-attention-days").innerHTML = daysHtml;
}

function setPopoverOpen(open) {
  if (!popover || !chip) return;
  popover.classList.toggle("hidden", !open);
  chip.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderPopover();
}

function saveCap() {
  var input = popover && popover.querySelector("#human-attention-cap-hours");
  var hours = input ? Number(input.value) : NaN;
  if (!isFinite(hours) || hours < 0.5 || hours > 24) {
    showToast("Daily cap must be between 0.5 and 24 hours", "error");
    return;
  }
  sendUserAction({
    type: "human_attention_cap_set",
    capMinutes: Math.round(hours * 60),
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
  });
}

function buildUi() {
  var status = document.querySelector(".title-bar-content .status");
  if (!status) return;
  wrap = document.createElement("div");
  wrap.id = "human-attention-wrap";
  wrap.className = "human-attention-wrap hidden";
  wrap.innerHTML =
    '<button type="button" id="human-attention-chip" class="human-attention-chip" aria-expanded="false" aria-controls="human-attention-popover" title="Human work today">' +
      '<i data-lucide="clock-3"></i><span id="human-attention-chip-text" aria-live="polite">0m</span>' +
    '</button>' +
    '<section id="human-attention-popover" class="human-attention-popover hidden" role="dialog" aria-modal="false" aria-labelledby="human-attention-title">' +
      '<div class="human-attention-heading"><div><strong id="human-attention-title">Human work</strong><span id="human-attention-coverage">5am–5am · all Clay devices</span></div>' +
        '<button type="button" id="human-attention-close" class="human-attention-close" aria-label="Close work budget" title="Close"><i data-lucide="x"></i></button></div>' +
      '<div class="human-attention-body">' +
        '<div class="human-attention-summary"><div class="human-attention-summary-primary"><span>Today</span><div><strong id="human-attention-today">0m</strong><small id="human-attention-budget-label">of 8h</small></div></div>' +
          '<div class="human-attention-summary-remaining"><span>Remaining</span><strong id="human-attention-remaining">8h</strong></div></div>' +
        '<div id="human-attention-progress" class="human-attention-progress" role="progressbar" aria-label="Daily work budget" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="human-attention-progress-fill"></span></div>' +
        '<div class="human-attention-scope"><div><span>This project</span><strong id="human-attention-project-today">0m</strong></div>' +
          '<div><span>All Clay time</span><strong id="human-attention-total">0m</strong></div></div>' +
        '<div class="human-attention-section"><div class="human-attention-section-title">Today by project</div><div id="human-attention-projects"></div></div>' +
        '<div class="human-attention-section"><div class="human-attention-section-title">Project totals</div><div id="human-attention-project-totals"></div></div>' +
        '<div class="human-attention-section"><div class="human-attention-section-title">Last 10 workdays</div><div id="human-attention-days"></div></div>' +
        '<div class="human-attention-cap"><div><label for="human-attention-cap-hours">Daily cap</label><span>Your stop point</span></div><div class="human-attention-cap-control"><span class="human-attention-cap-input"><input id="human-attention-cap-hours" type="number" min="0.5" max="24" step="0.5" inputmode="decimal"><span>h</span></span><button type="button" id="human-attention-cap-save">Update</button></div></div>' +
        '<p>Phone foreground time; desktop focused use plus a 5-minute thinking window. Hidden and background tabs are excluded.</p>' +
      '</div>' +
    '</section>';
  var search = document.getElementById("find-in-session-btn");
  status.insertBefore(wrap, search || status.firstChild);
  chip = document.getElementById("human-attention-chip");
  chipText = document.getElementById("human-attention-chip-text");
  popover = document.getElementById("human-attention-popover");
  var closeButton = popover.querySelector("#human-attention-close");
  var dismiss = function () { setPopoverOpen(false); };
  chip.addEventListener("click", function () { setPopoverOpen(popover.classList.contains("hidden")); });
  closeButton.addEventListener("pointerdown", function (event) {
    handleAttentionDismissEvent(event, dismiss);
  });
  closeButton.addEventListener("click", function (event) {
    handleAttentionDismissEvent(event, dismiss);
  });
  popover.querySelector("#human-attention-cap-save").addEventListener("click", saveCap);
  popover.querySelector("#human-attention-cap-hours").addEventListener("keydown", function (event) {
    if (event.key === "Enter") saveCap();
  });
  document.addEventListener("keydown", function (event) {
    if (!popover || popover.classList.contains("hidden")) return;
    handleAttentionDismissEvent(event, function () {
      setPopoverOpen(false);
      if (chip && typeof chip.focus === "function") chip.focus();
    });
  }, true);
  document.addEventListener("pointerdown", function (event) {
    if (popover && !popover.classList.contains("hidden") && !wrap.contains(event.target)) setPopoverOpen(false);
  }, true);
}

export function handleHumanAttentionMessage(msg) {
  if (!msg) return false;
  if (msg.type === "human_attention_state") {
    state = msg;
    renderChip();
    if (popover && !popover.classList.contains("hidden")) renderPopover();
    return true;
  }
  if (msg.type === "human_attention_error") {
    showToast(msg.error || "Could not update work budget", "error");
    return true;
  }
  return false;
}

export function initHumanAttention() {
  buildUi();
  if (pageVisible() && (usesMobileForegroundMode() || pageFocused())) {
    lastInteractionAt = Date.now();
    pendingExplicit = true;
  }
  document.addEventListener("pointerdown", noteInteraction, { capture: true, passive: true });
  document.addEventListener("keydown", noteInteraction, true);
  document.addEventListener("input", noteInteraction, true);
  document.addEventListener("scroll", noteInteraction, { capture: true, passive: true });
  document.addEventListener("visibilitychange", function () {
    if (pageVisible()) noteInteraction();
    else sendInactive();
  });
  window.addEventListener("focus", noteInteraction);
  window.addEventListener("blur", sendInactive);
  window.addEventListener("pagehide", sendInactive);
  store.subscribe(function (next, previous) {
    if (next.connected && !previous.connected) sendSignal(pendingExplicit);
    if (next.connected && (next.activeSessionId !== previous.activeSessionId ||
        next.currentSlug !== previous.currentSlug)) sendSignal(pendingExplicit);
  });
  heartbeatTimer = setInterval(function () { sendSignal(pendingExplicit); }, HEARTBEAT_MS);
  repaintTimer = setInterval(renderChip, 1000);
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  if (repaintTimer && typeof repaintTimer.unref === "function") repaintTimer.unref();
}

export { formatDuration };
