import { escapeHtml } from './utils.js';
import { iconHtml } from './icons.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { sendUserAction } from './app-connection.js';
import { dismissOverlayPanels, closeSidebar } from './sidebar.js';
import { appendSessionCloseButton } from './sidebar-sessions-delete.js';
import { showLoopCtxMenu } from './sidebar-sessions-context-menu.js';

function switchToSession(id) {
  if (getWs() && store.get('connected')) {
    sendUserAction({ type: "switch_session", id: id });
    dismissOverlayPanels();
    closeSidebar();
  }
}

function renderLoopChild(s, deps) {
  var searchMatchIds = deps.getSearchMatchIds();
  var el = document.createElement("div");
  var isMatch = searchMatchIds !== null && searchMatchIds.has(s.id);
  el.className = "session-loop-child" + (s.active ? " active" : "") + (isMatch ? " search-match" : "");
  el.dataset.sessionId = s.id;

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  if (s.isProcessing) {
    textHtml += '<span class="session-processing"></span>';
  }
  if (s.loop) {
    var isRalphChild = s.loop.source === "ralph";
    var roleName = s.loop.role === "crafting" ? "Crafting" : s.loop.role === "judge" ? "Judge" : (isRalphChild ? "Coder" : "Run");
    var iterSuffix = s.loop.role === "crafting" ? "" : " #" + s.loop.iteration;
    var roleCls = s.loop.role === "crafting" ? " crafting" : (!isRalphChild ? " scheduled" : "");
    textHtml += '<span class="session-loop-role-badge' + roleCls + '">' + roleName + iterSuffix + '</span>';
  }
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);
  appendSessionCloseButton(el, s);

  el.addEventListener("click", (function (id) {
    return function () {
      switchToSession(id);
    };
  })(s.id));

  return el;
}

function renderLoopRun(parentGk, startedAtKey, sessions, isRalph, deps) {
  var expandedLoopRuns = deps.getExpandedLoopRuns();
  var runGk = parentGk + ":" + startedAtKey;
  var expanded = expandedLoopRuns.has(runGk);
  var startedAt = Number(startedAtKey);
  var timeLabel = startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Unknown";

  var hasActive = false;
  var anyProcessing = false;
  var latestSession = sessions[0];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].active) hasActive = true;
    if (sessions[i].isProcessing) anyProcessing = true;
    if ((sessions[i].lastActivity || 0) > (latestSession.lastActivity || 0)) {
      latestSession = sessions[i];
    }
  }

  var wrapper = document.createElement("div");
  wrapper.className = "session-loop-run-wrapper";

  var el = document.createElement("div");
  el.className = "session-loop-run" + (hasActive ? " active" : "") + (expanded ? " expanded" : "") + (isRalph ? "" : " scheduled");

  var chevron = document.createElement("button");
  chevron.className = "session-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  chevron.addEventListener("click", (function (rk) {
    return function (e) {
      e.stopPropagation();
      if (expandedLoopRuns.has(rk)) {
        expandedLoopRuns.delete(rk);
      } else {
        expandedLoopRuns.add(rk);
      }
      deps.renderSessionList(null);
    };
  })(runGk));
  el.appendChild(chevron);

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  if (anyProcessing) {
    textHtml += '<span class="session-processing"></span>';
  }
  textHtml += '<span class="session-loop-run-time">' + escapeHtml(timeLabel) + '</span>';
  textHtml += '<span class="session-loop-count' + (isRalph ? "" : " scheduled") + '">' + sessions.length + '</span>';
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);

  el.addEventListener("click", (function (id) {
    return function () {
      switchToSession(id);
    };
  })(latestSession.id));

  wrapper.appendChild(el);

  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "session-loop-children";
    for (var k = 0; k < sessions.length; k++) {
      childContainer.appendChild(renderLoopChild(sessions[k], deps));
    }
    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

export function renderLoopGroup(loopId, children, groupKey, deps) {
  var searchMatchIds = deps.getSearchMatchIds();
  var expandedLoopGroups = deps.getExpandedLoopGroups();
  var visibleChildren = children;
  if (searchMatchIds !== null) {
    visibleChildren = [];
    for (var vi = 0; vi < children.length; vi++) {
      if (searchMatchIds.has(children[vi].id)) {
        visibleChildren.push(children[vi]);
      }
    }
    if (visibleChildren.length === 0) {
      return null;
    }
  }

  var gk = groupKey || loopId;

  var runMap = {};
  for (var i = 0; i < visibleChildren.length; i++) {
    var runKey = String(visibleChildren[i].loop && visibleChildren[i].loop.startedAt || 0);
    if (!runMap[runKey]) runMap[runKey] = [];
    runMap[runKey].push(visibleChildren[i]);
  }
  var runKeys = Object.keys(runMap);

  for (var ri = 0; ri < runKeys.length; ri++) {
    runMap[runKeys[ri]].sort(function (a, b) {
      var ai = (a.loop && a.loop.iteration) || 0;
      var bi = (b.loop && b.loop.iteration) || 0;
      if (ai !== bi) return ai - bi;
      var ar = (a.loop && a.loop.role === "judge") ? 1 : 0;
      var br = (b.loop && b.loop.role === "judge") ? 1 : 0;
      return ar - br;
    });
  }

  runKeys.sort(function (a, b) { return Number(b) - Number(a); });

  var expanded = expandedLoopGroups.has(gk);
  var hasActive = false;
  var anyProcessing = false;
  var latestSession = visibleChildren[0];
  for (var ci = 0; ci < visibleChildren.length; ci++) {
    if (visibleChildren[ci].active) hasActive = true;
    if (visibleChildren[ci].isProcessing) anyProcessing = true;
    if ((visibleChildren[ci].lastActivity || 0) > (latestSession.lastActivity || 0)) {
      latestSession = visibleChildren[ci];
    }
  }

  var loopName = (visibleChildren[0].loop && visibleChildren[0].loop.name) || "Loop";
  var isRalph = visibleChildren[0].loop && visibleChildren[0].loop.source === "ralph";
  var isDebate = visibleChildren[0].loop && visibleChildren[0].loop.source === "debate";
  var isCrafting = false;
  for (var j = 0; j < visibleChildren.length; j++) {
    if (visibleChildren[j].loop && visibleChildren[j].loop.role === "crafting") isCrafting = true;
  }

  var runCount = runKeys.length;

  var wrapper = document.createElement("div");
  wrapper.className = "session-loop-wrapper";

  var el = document.createElement("div");
  var groupClass = "session-loop-group" + (hasActive ? " active" : "") + (expanded ? " expanded" : "");
  if (isDebate) groupClass += " debate";
  else if (!isRalph) groupClass += " scheduled";
  el.className = groupClass;
  el.dataset.loopId = loopId;

  var chevron = document.createElement("button");
  chevron.className = "session-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  chevron.addEventListener("click", (function (lid) {
    return function (e) {
      e.stopPropagation();
      if (expandedLoopGroups.has(lid)) {
        expandedLoopGroups.delete(lid);
      } else {
        expandedLoopGroups.add(lid);
      }
      deps.renderSessionList(null);
    };
  })(gk));
  el.appendChild(chevron);

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  if (anyProcessing) {
    textHtml += '<span class="session-processing"></span>';
  }
  var groupIcon = isDebate ? "mic" : (isRalph ? "repeat" : "calendar-clock");
  var iconClass = isDebate ? " debate" : (isRalph ? "" : " scheduled");
  textHtml += '<span class="session-loop-icon' + iconClass + '">' + iconHtml(groupIcon) + '</span>';
  textHtml += '<span class="session-loop-name">' + escapeHtml(loopName) + '</span>';
  if (isCrafting && children.length === 1) {
    textHtml += '<span class="session-loop-badge crafting">Crafting</span>';
  } else {
    var countLabel = runCount === 1 ? visibleChildren.length : runCount + (runCount === 1 ? " run" : " runs");
    var countClass = isDebate ? " debate" : (isRalph ? "" : " scheduled");
    textHtml += '<span class="session-loop-count' + countClass + '">' + countLabel + '</span>';
  }
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);

  var moreBtn = document.createElement("button");
  moreBtn.className = "session-more-btn";
  moreBtn.innerHTML = iconHtml("ellipsis");
  moreBtn.title = "More options";
  moreBtn.addEventListener("click", (function (lid, name, count, btn) {
    return function (e) {
      e.stopPropagation();
      showLoopCtxMenu(btn, lid, name, count);
    };
  })(loopId, loopName, visibleChildren.length, moreBtn));
  el.appendChild(moreBtn);

  el.addEventListener("click", (function (id) {
    return function () {
      switchToSession(id);
    };
  })(latestSession.id));

  wrapper.appendChild(el);

  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "session-loop-children";

    if (runCount === 1) {
      var singleRun = runMap[runKeys[0]];
      for (var sk = 0; sk < singleRun.length; sk++) {
        childContainer.appendChild(renderLoopChild(singleRun[sk], deps));
      }
    } else {
      for (var rk = 0; rk < runKeys.length; rk++) {
        childContainer.appendChild(renderLoopRun(gk, runKeys[rk], runMap[runKeys[rk]], isRalph, deps));
      }
    }

    wrapper.appendChild(childContainer);
  }

  return wrapper;
}
