import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { sendUserAction } from './app-connection.js';
import { escapeHtml, showToast } from './utils.js';

var HEARTBEAT_MS = 10000;
var THINKING_GRACE_MS = 3 * 60 * 1000;
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

function pageVisible() {
  return document.hidden !== true;
}

function pageFocused() {
  if (typeof document.hasFocus !== "function") return true;
  return document.hasFocus();
}

function formatDuration(durationMs) {
  var minutes = Math.max(0, Math.floor(Number(durationMs || 0) / 60000));
  if (minutes < 60) return minutes + "m";
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  return rest ? hours + "h " + rest + "m" : hours + "h";
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

export function buildAttentionSignalPayload(now, visible, focused, interactedAt, explicit, offset) {
  var engaged = visible && focused && interactedAt > 0 &&
    now - interactedAt <= THINKING_GRACE_MS;
  return {
    type: "human_attention_signal",
    visible: visible,
    focused: focused,
    engaged: engaged,
    interaction: explicit === true && engaged,
    timezoneOffsetMinutes: offset,
  };
}

function sendSignal(explicit) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !store.get('connected')) return false;
  var now = Date.now();
  var visible = pageVisible();
  var focused = pageFocused();
  var payload = buildAttentionSignalPayload(now, visible, focused,
    lastInteractionAt, explicit, new Date().getTimezoneOffset());
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
  if (!rows || !rows.length) return '<div class="human-attention-empty">No activity yet</div>';
  var html = "";
  for (var i = 0; i < rows.length; i++) {
    html += '<div class="human-attention-row"><span>' + escapeHtml(rows[i].projectSlug) +
      '</span><strong>' + formatDuration(rows[i].durationMs) + '</strong></div>';
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
    daysHtml += '<div class="human-attention-row human-attention-day"><span>' +
      escapeHtml(dayLabel(state.days[i].key, i)) + '</span><strong>' +
      formatDuration(state.days[i].totalMs) + '</strong></div>';
  }
  popover.querySelector("#human-attention-today").textContent = formatDuration(todayMs);
  popover.querySelector("#human-attention-remaining").textContent =
    todayMs >= capMs ? "Cap reached" : formatDuration(capMs - todayMs) + " left";
  popover.querySelector("#human-attention-total").textContent = formatDuration(state.totalMs);
  popover.querySelector("#human-attention-project-today").textContent = formatDuration(state.projectTodayMs);
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
    '<button type="button" id="human-attention-chip" class="human-attention-chip" aria-expanded="false" title="Human work today">' +
      '<i data-lucide="clock-3"></i><span id="human-attention-chip-text">0m</span>' +
    '</button>' +
    '<section id="human-attention-popover" class="human-attention-popover hidden" aria-label="Human work budget">' +
      '<div class="human-attention-heading"><div><strong>Human work budget</strong><span>5am–5am · all Clay devices</span></div>' +
        '<button type="button" id="human-attention-close" aria-label="Close"><i data-lucide="x"></i></button></div>' +
      '<div class="human-attention-summary"><div><span>Today</span><strong id="human-attention-today">0m</strong></div>' +
        '<div><span>Remaining</span><strong id="human-attention-remaining">0m</strong></div></div>' +
      '<div class="human-attention-progress"><span id="human-attention-progress-fill"></span></div>' +
      '<div class="human-attention-row"><span>This project today</span><strong id="human-attention-project-today">0m</strong></div>' +
      '<div class="human-attention-row"><span>All recorded Clay time</span><strong id="human-attention-total">0m</strong></div>' +
      '<div class="human-attention-section-title">Today by project</div><div id="human-attention-projects"></div>' +
      '<div class="human-attention-section-title">All time by project</div><div id="human-attention-project-totals"></div>' +
      '<div class="human-attention-section-title">Last 10 workdays</div><div id="human-attention-days"></div>' +
      '<label class="human-attention-cap"><span>Daily cap (hours)</span><div><input id="human-attention-cap-hours" type="number" min="0.5" max="24" step="0.5"><button type="button" id="human-attention-cap-save">Save</button></div></label>' +
      '<p>Counts focused interaction plus a 3-minute reading/thinking window. Hidden tabs and unattended AI work do not count.</p>' +
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
  if (pageVisible() && pageFocused()) {
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
