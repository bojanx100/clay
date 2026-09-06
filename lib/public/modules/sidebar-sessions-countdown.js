import { escapeHtml } from './utils.js';
import { iconHtml } from './icons.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getSessionListEl } from './dom-refs.js';
import { getUpcomingSchedules } from './scheduler.js';
import { showAutoLaunchActivityPopover } from './sidebar-sessions-activity.js';

var countdownTimer = null;
var countdownContainer = null;
var AUTOLAUNCH_REC_ID = "autolaunch_assigned";
var autoLaunchActivity = { events: [] };
var activityRequested = false;

export function openAutoLaunchActivity(anchor) {
  if (!anchor) return;
  showAutoLaunchActivityPopover(anchor, autoLaunchActivity.events || []);
}

export function startCountdownTimer() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdowns, 1000);
}

function formatCountdown(sec) {
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var mm = (m < 10 ? "0" : "") + m;
  var ss = (s < 10 ? "0" : "") + s;
  if (h > 0) return h + ":" + mm + ":" + ss;
  return m + ":" + ss;
}

export function updateCountdowns() {
  var listEl = getSessionListEl();
  if (!listEl) return;
  var upcoming = getUpcomingSchedules(Number.MAX_SAFE_INTEGER);

  if (countdownContainer && !listEl.contains(countdownContainer)) {
    countdownContainer = null;
  }

  if (upcoming.length === 0) {
    if (countdownContainer) {
      countdownContainer.remove();
      countdownContainer = null;
    }
    return;
  }

  var hasAutolaunch = false;
  for (var a = 0; a < upcoming.length; a++) { if (upcoming[a].id === AUTOLAUNCH_REC_ID) { hasAutolaunch = true; break; } }
  if (!store.get('connected')) {
    activityRequested = false;
  } else if (hasAutolaunch && !activityRequested && getWs()) {
    getWs().send(JSON.stringify({ type: "get_auto_launch_activity" }));
    activityRequested = true;
  }

  if (!countdownContainer) {
    countdownContainer = document.createElement("div");
    countdownContainer.className = "session-countdown-group";
    countdownContainer.addEventListener("click", function (e) {
      var item = e.target.closest && e.target.closest('.session-countdown-item[data-act="1"]');
      if (item) { e.stopPropagation(); showAutoLaunchActivityPopover(item, autoLaunchActivity.events || []); }
    });
    var stickyTop = listEl.querySelector(".session-list-sticky-top");
    if (stickyTop && stickyTop.nextSibling) {
      listEl.insertBefore(countdownContainer, stickyTop.nextSibling);
    } else if (stickyTop) {
      listEl.appendChild(countdownContainer);
    } else {
      listEl.insertBefore(countdownContainer, listEl.firstChild);
    }
  }

  var html = "";
  var now = Date.now();
  for (var i = 0; i < upcoming.length; i++) {
    var u = upcoming[i];
    var remaining = Math.max(0, Math.ceil((u.nextRunAt - now) / 1000));
    var timeStr = u.paused ? "Paused" : formatCountdown(remaining);
    var colorStyle = u.color ? " style=\"border-left-color:" + u.color + "\"" : "";
    var actBadges = "";
    var clickable = "";
    if (u.id === AUTOLAUNCH_REC_ID) {
      var evs = autoLaunchActivity.events || [];
      var dayMs = startOfTodayMs();
      var doneToday = 0;
      var completedEver = 0;
      for (var e2 = 0; e2 < evs.length; e2++) {
        if (evs[e2].type !== "completed") continue;
        completedEver++;
        if (evs[e2].ts >= dayMs) doneToday++;
      }
      if (doneToday > 0) actBadges += '<span class="session-countdown-act done" title="' + doneToday + ' session(s) completed today">' + iconHtml("check") + doneToday + '</span>';
      if (completedEver > 0) clickable = ' data-act="1" title="Click to see auto-launch history"';
    }
    html += '<div class="session-countdown-item"' + colorStyle + clickable + '>';
    html += '<span class="session-countdown-name">' + escapeHtml(u.name) + '</span>';
    html += actBadges;
    html += '<span class="session-countdown-badge">' + timeStr + '</span>';
    html += '</div>';
  }
  if (countdownContainer._lastHtml !== html) {
    countdownContainer.innerHTML = html;
    countdownContainer._lastHtml = html;
  }
}

export function setAutoLaunchActivity(data) {
  autoLaunchActivity = { events: (data && data.events) || [] };
  updateCountdowns();
  try {
    window.dispatchEvent(new CustomEvent("clay:auto-launch-activity"));
  } catch (e) {}
}

export function getAutoLaunchActivitySummary() {
  var evs = autoLaunchActivity.events || [];
  var dayMs = startOfTodayMs();
  var startedToday = 0;
  var doneToday = 0;
  for (var i = 0; i < evs.length; i++) {
    if (evs[i].ts < dayMs) continue;
    // Only a real launch counts as started; a proposal handed to Coop is not
    // a started session and must not inflate the count.
    if (evs[i].type === "completed") doneToday++;
    else if (evs[i].type === "started") startedToday++;
  }
  return {
    events: evs,
    startedToday: startedToday,
    doneToday: doneToday,
  };
}

function startOfTodayMs() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
