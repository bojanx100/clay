import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { sendUserAction } from './app-connection.js';
import { closeSidebar } from './sidebar.js';
import { showConfirm } from './confirm-modal.js';

var activityPopover = null;

function startOfTodayMs() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function activityDayLabel(ts) {
  var startToday = startOfTodayMs();
  if (ts >= startToday) return "Today";
  if (ts >= startToday - 86400000) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function activityRelTime(ts) {
  var diff = Date.now() - ts;
  var m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function closeActivityPopover() {
  if (!activityPopover) return;
  activityPopover.remove();
  activityPopover = null;
  document.removeEventListener("click", onActivityOutside, true);
}

function onActivityOutside(e) {
  if (activityPopover && !activityPopover.contains(e.target)) closeActivityPopover();
}

export function showAutoLaunchActivityPopover(anchor, allEvents) {
  closeActivityPopover();
  var events = (allEvents || []).filter(function (e) { return e.type === "completed"; });
  var pop = document.createElement("div");
  pop.className = "autolaunch-activity-popover";
  var html = '<div class="alap-header">Auto-launch activity'
    + (events.length > 0 ? '<button class="alap-clear" type="button">Clear</button>' : '')
    + '</div>';
  if (events.length === 0) {
    html += '<div class="alap-empty">Nothing yet.</div>';
  } else {
    html += '<div class="alap-list">';
    var lastDay = null;
    for (var i = 0; i < events.length && i < 100; i++) {
      var ev = events[i];
      var day = activityDayLabel(ev.ts);
      if (day !== lastDay) { html += '<div class="alap-day">' + day + '</div>'; lastDay = day; }
      var isPr = ev.autoKind === "pr-review";
      var icons = { completed: "check", started: "play", proposed: "inbox",
        blocked: "slash", failed: "alert", unknown: "help" };
      var labels = { completed: "done", started: "started", proposed: "proposed",
        blocked: "blocked", failed: "failed", unknown: "unknown" };
      var ico = iconHtml(icons[ev.type] || "help");
      var label = labels[ev.type] || ev.type;
      var sid = (ev.sessionId != null) ? String(ev.sessionId) : "";
      var stid = ev.storageId ? String(ev.storageId) : "";
      html += '<button class="alap-item ' + ev.type + '" data-session-id="' + sid + '" data-storage-id="' + escapeHtml(stid) + '">';
      html += '<span class="alap-ico ' + ev.type + '">' + ico + '</span>';
      html += '<span class="alap-body">';
      html += '<span class="alap-title"><span class="alap-kind ' + (isPr ? 'pr' : 'issue') + '">' + (isPr ? 'PR' : 'issue') + '</span> ' + escapeHtml(ev.title || ("#" + (ev.number != null ? ev.number : ""))) + '</span>';
      if (ev.summary) html += '<span class="alap-sum">' + escapeHtml(ev.summary) + '</span>';
      html += '<span class="alap-meta">' + label + ' · ' + activityRelTime(ev.ts) + '</span>';
      html += '</span></button>';
    }
    html += '</div>';
  }
  pop.innerHTML = html;
  document.body.appendChild(pop);
  var r = anchor.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pop.offsetHeight - 8) + "px";
  refreshIcons();
  var items = pop.querySelectorAll(".alap-item");
  for (var k = 0; k < items.length; k++) {
    items[k].addEventListener("click", function () {
      var sid = this.getAttribute("data-session-id");
      var stid = this.getAttribute("data-storage-id");
      if (sid || stid) {
        var swMsg = { type: "switch_session" };
        if (stid) swMsg.storageId = stid;
        if (sid) swMsg.id = parseInt(sid, 10);
        if (sendUserAction(swMsg)) closeSidebar();
      }
      closeActivityPopover();
    });
  }
  var clearBtn = pop.querySelector(".alap-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      showConfirm("Clear all auto-launch activity? This cannot be undone.", function () {
        sendUserAction({ type: "clear_auto_launch_activity" });
        closeActivityPopover();
      });
    });
  }
  activityPopover = pop;
  setTimeout(function () { document.addEventListener("click", onActivityOutside, true); }, 0);
}
