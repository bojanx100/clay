// sidebar-sessions.js - Session list, search, presence, countdown, CLI picker
// Extracted from sidebar.js (PR-35)

import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { openSearch as openSessionSearch } from './session-search.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { sendUserAction } from './app-connection.js';
import { getSessionListEl } from './dom-refs.js';
import { dismissOverlayPanels, closeSidebar, updatePageTitle } from './sidebar.js';
import { refreshMobileChatSheet } from './sidebar-mobile.js';
import { providerShortName } from './provider-route-ui.js';
import { openImportSessionPicker, handleCliSessionList, handleCliSessionImported } from './sidebar-sessions-import.js';
import { initSessionHeaderSearch, syncSessionHeaderSearchUi } from './sidebar-sessions-header-search.js';
import { renderPresenceAvatars, updateSessionPresence, updateSessionBadge } from './sidebar-sessions-presence.js';
import { startCountdownTimer, updateCountdowns, setAutoLaunchActivity, getAutoLaunchActivitySummary, openAutoLaunchActivity } from './sidebar-sessions-countdown.js';
import { getDateGroup, highlightMatch } from './sidebar-sessions-groups.js';
import { appendSessionCloseButton, clearArmedSessionDelete } from './sidebar-sessions-delete.js';
import { createSessionGroupHeader } from './sidebar-sessions-group-header.js';
import { setupBookmarkDropTarget, setupSessionDragHandlers } from './sidebar-sessions-drag.js';
import { renderSessionTopActions } from './sidebar-sessions-top-actions.js';
import { closeSessionCtxMenu, hasSessionCtxMenu, setSessionCtxMenu, showSessionCtxMenu, openSessionActionMenu } from './sidebar-sessions-context-menu.js';
import { renderLoopGroup } from './sidebar-sessions-loop-render.js';

export { openImportSessionPicker, handleCliSessionList, handleCliSessionImported };
export { updateSessionPresence, updateSessionBadge };
export { setAutoLaunchActivity, getAutoLaunchActivitySummary, openAutoLaunchActivity };
export { getDateGroup, highlightMatch };
export { openSessionActionMenu };


// --- Session state ---
var cachedSessions = [];
var searchQuery = "";
var searchMatchIds = null; // null = no search, Set of matched session IDs
var expandedLoopGroups = new Set();
var expandedLoopRuns = new Set();

// Signature of the last fully-rendered list (excludes which row is "active").
// Lets renderSessionList skip the full teardown/rebuild — which flickers the
// list and the auto-launch/countdown row — when only the active selection
// changed, updating the highlight in place instead.
var _listSignature = null;
// Frozen display order: the session list keeps its order while you stay in a
// project, and only re-sorts by recency when you (re-)enter the project. Avoids
// the list reshuffling under you as sessions gain activity.
var frozenOrder = null;
var frozenOrderSlug = null;

store.subscribe(function (state, prev) {
  if ((state.activeSessionId !== prev.activeSessionId ||
       state.sessionVendorOverrides !== prev.sessionVendorOverrides) &&
      cachedSessions.length > 0) {
    renderSessionList(null);
  }
});
function sessionVendorOverrideKey(sessionId, cliSessionId) {
  var slug = store.get('currentSlug') || "";
  return slug + ":" + (cliSessionId || ("local:" + sessionId));
}

function compareSessionListItems(a, b) {
  var aData = a && a.type === "session" ? a.data : a;
  var bData = b && b.type === "session" ? b.data : b;
  var aBookmarked = !!(aData && aData.bookmarked);
  var bBookmarked = !!(bData && bData.bookmarked);
  if (aBookmarked !== bBookmarked) return aBookmarked ? -1 : 1;
  if (aBookmarked && bBookmarked) {
    var ao = aData && typeof aData.favoriteOrder === "number" ? aData.favoriteOrder : Number.MAX_SAFE_INTEGER;
    var bo = bData && typeof bData.favoriteOrder === "number" ? bData.favoriteOrder : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
  }
  return (b.lastActivity || 0) - (a.lastActivity || 0);
}

function collectItemSessionIds(item) {
  if (!item) return [];
  if (item.type === "session" && item.data && typeof item.data.id === "number") {
    if (!isSessionVisibleBySearch(item.data.id)) return [];
    return [item.data.id];
  }
  if (item.type === "loop" && Array.isArray(item.children)) {
    var ids = [];
    for (var i = 0; i < item.children.length; i++) {
      if (typeof item.children[i].id === "number" && isSessionVisibleBySearch(item.children[i].id)) {
        ids.push(item.children[i].id);
      }
    }
    return ids;
  }
  return [];
}

export function initSidebarSessions() {

  document.addEventListener("click", function () {
    closeSessionCtxMenu();
    clearArmedSessionDelete();
  });

  initSessionHeaderSearch(getHeaderSearchDeps());

  // --- Resume session picker ---
  // --- Schedule countdown timer ---
  startCountdownTimer();
}

// --- Getters for cross-module access ---

export function getCachedSessions() {
  return cachedSessions;
}

export function getSearchQuery() {
  return searchQuery;
}

export function getSearchMatchIds() {
  return searchMatchIds;
}

function setSearchQuery(value) {
  searchQuery = value || "";
}

function setSearchMatchIds(value) {
  searchMatchIds = value;
}

function getHeaderSearchDeps() {
  return {
    getSearchQuery: getSearchQuery,
    setSearchQuery: setSearchQuery,
    getSearchMatchIds: getSearchMatchIds,
    setSearchMatchIds: setSearchMatchIds,
    renderSessionList: renderSessionList,
  };
}

export function getExpandedLoopGroups() {
  return expandedLoopGroups;
}

export function getExpandedLoopRuns() {
  return expandedLoopRuns;
}

function getTopActionDeps() {
  return {
    hasMenu: hasSessionCtxMenu,
    closeMenu: closeSessionCtxMenu,
    setMenu: setSessionCtxMenu,
  };
}

function isSessionVisibleBySearch(sessionId) {
  if (searchMatchIds === null) return true;
  return searchMatchIds.has(sessionId);
}

function getLoopRenderDeps() {
  return {
    getSearchMatchIds: getSearchMatchIds,
    getExpandedLoopGroups: getExpandedLoopGroups,
    getExpandedLoopRuns: getExpandedLoopRuns,
    renderSessionList: renderSessionList,
  };
}

// --- Session item rendering ---

function renderSessionItem(s) {
  var el = document.createElement("div");
  var isMatch = searchMatchIds !== null && searchMatchIds.has(s.id);
  el.className = "session-item" + (s.active ? " active" : "") + (isMatch ? " search-match" : "");
  el.dataset.sessionId = s.id;

  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  var textHtml = "";
  if (s.loop && s.loop.source === "debate") {
    textHtml += '<span class="session-debate-icon" title="Debate">' + iconHtml("mic") + '</span>';
  }
  if (store.get('isMultiUserMode') && s.sessionVisibility === "private") {
    textHtml += '<span class="session-private-icon" title="Private session">' + iconHtml("lock") + '</span>';
  }
  var vendorOverrides = store.get('sessionVendorOverrides') || {};
  var rememberedVendor = s.vendor ? "" : (vendorOverrides[sessionVendorOverrideKey(s.id, s.cliSessionId)] || "");
  var sessionVendor = s.vendor || rememberedVendor || "claude";
  var routeFamily = providerShortName(sessionVendor, s.providerRouteId || null, s.model || "").toLowerCase();
  var dotVendor = routeFamily === "codex" ? "codex" : "claude";
  var vendorDotClass = "session-vendor-dot " + dotVendor + (s.isProcessing ? " processing" : "");
  textHtml += '<span class="' + vendorDotClass + '" title="' + providerShortName(sessionVendor, s.providerRouteId || null, s.model || "") + ' session"></span>';
  // Auto-launch badge: marks sessions started automatically (issues vs PR fixes).
  if (s.taskLauncher && s.taskLauncher.autoLaunch) {
    var isPrFix = s.taskLauncher.kind === "pr-review";
    textHtml += '<span class="session-auto-badge' + (isPrFix ? ' pr' : '') + '" title="' + (isPrFix ? 'Auto-launched PR fix' : 'Auto-launched task') + '">' + (isPrFix ? 'PR fix' : 'Auto') + '</span>';
  }
  textHtml += highlightMatch(s.title || "New Session", searchQuery);
  textSpan.innerHTML = textHtml;
  el.appendChild(textSpan);

  // Right-click / long-press: context menu
  el.addEventListener("contextmenu", (function(id, title, cliSid, anchor, sData) {
    return function(e) {
      e.preventDefault();
      e.stopPropagation();
      showSessionCtxMenu(anchor, id, title, cliSid, sData);
    };
  })(s.id, s.title, s.cliSessionId, el, s));

  // Unread badge
  var unreadBadge = document.createElement("span");
  unreadBadge.className = "session-unread-badge";
  unreadBadge.dataset.sessionId = s.id;
  if (s.unread > 0) {
    unreadBadge.textContent = s.unread > 99 ? "99+" : String(s.unread);
    unreadBadge.classList.add("has-unread");
  }
  el.appendChild(unreadBadge);
  appendSessionCloseButton(el, s);

  el.addEventListener("click", (function (id) {
    return function () {
      if (getWs() && store.get('connected')) {
        var pendingQuery = searchQuery || "";
        sendUserAction({ type: "switch_session", id: id });
        dismissOverlayPanels();
        closeSidebar();
        if (pendingQuery) {
          setTimeout(function () { openSessionSearch(pendingQuery); }, 400);
        }
      }
    };
  })(s.id));

  // Presence avatars (multi-user)
  renderPresenceAvatars(el, String(s.id));
  setupSessionDragHandlers(el, s);

  return el;
}

// --- Main session list ---

// Build a signature of everything that affects the rendered list EXCEPT which
// row is active. When this is unchanged, a re-render would only move the active
// highlight — so we skip the rebuild and update the highlight in place.
function sessionListSignature(sessions) {
  var parts = [];
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var loop = s.loop || null;
    parts.push([
      s.id,
      s.title || "",
      s.isProcessing ? 1 : 0,
      s.bookmarked ? 1 : 0,
      s.unread || s.unreadCount || 0,
      s.visibility || "",
      s.vendor || "",
      loop ? (loop.loopId + "/" + (loop.role || "") + "/" + (loop.iteration || "") + "/" + (loop.status || "") + "/" + (loop.source || "") + "/" + (loop.startedAt || "")) : ""
    ].join(""));
  }
  // The loopId currently holding the active session, so switching into/out of a
  // loop group still triggers a full rebuild (group wrappers highlight by child).
  var activeGroup = "";
  for (var a = 0; a < sessions.length; a++) {
    if (sessions[a].active && sessions[a].loop && sessions[a].loop.loopId) { activeGroup = sessions[a].loop.loopId; break; }
  }
  var searchSig = (searchQuery || "") + "|" + (searchMatchIds ? Array.from(searchMatchIds).sort().join(",") : "");
  return parts.join("") + "||g:" + activeGroup + "||s:" + searchSig;
}

function updateActiveHighlight() {
  var listEl = getSessionListEl();
  if (!listEl) return;
  var activeId = String(store.get('activeSessionId') || "");
  var rows = listEl.querySelectorAll('.session-item[data-session-id], .session-loop-child[data-session-id]');
  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("active", rows[i].dataset.sessionId === activeId);
  }
}

export function renderSessionList(sessions) {
  if (sessions) cachedSessions = sessions;

  // If mobile chat sheet is open, refresh it
  if (refreshMobileChatSheet) refreshMobileChatSheet();

  // Skip the full teardown/rebuild when only the active selection changed —
  // preserves the auto-launch/countdown row and avoids list flicker on switch.
  var sig = sessionListSignature(cachedSessions);
  if (sig === _listSignature && getSessionListEl().children.length > 0) {
    updateActiveHighlight();
    return;
  }
  _listSignature = sig;

  getSessionListEl().innerHTML = "";

  // Partition: loop sessions vs normal sessions
  // Group by loopId + date so all runs of the same task on the same day are merged
  var loopGroups = {}; // groupKey -> [sessions]
  var normalSessions = [];
  for (var i = 0; i < cachedSessions.length; i++) {
    var s = cachedSessions[i];
    if (s.loop && s.loop.loopId && s.loop.role === "crafting" && s.loop.source !== "ralph" && s.loop.source !== "debate") {
      // Task crafting sessions live in the scheduler calendar, not the main list (except debate)
      continue;
    } else if (s.loop && s.loop.loopId) {
      var startedAt = s.loop.startedAt || 0;
      var dateStr = startedAt ? new Date(startedAt).toISOString().slice(0, 10) : "unknown";
      var groupKey = s.loop.loopId + ":" + dateStr;
      if (!loopGroups[groupKey]) loopGroups[groupKey] = [];
      loopGroups[groupKey].push(s);
    } else {
      normalSessions.push(s);
    }
  }

  // Build virtual items: normal sessions + one entry per loop group (using latest child's lastActivity)
  var items = [];
  for (var j = 0; j < normalSessions.length; j++) {
    items.push({ type: "session", data: normalSessions[j], lastActivity: normalSessions[j].lastActivity || 0 });
  }
  var groupKeys = Object.keys(loopGroups);
  for (var k = 0; k < groupKeys.length; k++) {
    var gk = groupKeys[k];
    var children = loopGroups[gk];
    var realLoopId = children[0].loop.loopId;
    var maxActivity = 0;
    for (var m = 0; m < children.length; m++) {
      var act = children[m].lastActivity || 0;
      if (act > maxActivity) maxActivity = act;
    }
    items.push({ type: "loop", loopId: realLoopId, groupKey: gk, children: children, lastActivity: maxActivity });
  }

  // Order: keep the frozen order while in the project; only sort by recency
  // when (re-)entering the project. New items appear at the front by recency
  // and then join the frozen order so they don't jump on later renders.
  var curSlug = store.get('currentSlug') || "";
  var itemKey = function (it) { return it.type === "loop" ? ("l:" + it.groupKey) : ("s:" + (it.data && it.data.id)); };
  if (frozenOrderSlug !== curSlug || !frozenOrder) {
    items.sort(compareSessionListItems);
    frozenOrder = items.map(itemKey);
    frozenOrderSlug = curSlug;
  } else {
    var rank = {};
    for (var fi = 0; fi < frozenOrder.length; fi++) rank[frozenOrder[fi]] = fi;
    var known = [];
    var fresh = [];
    for (var xi = 0; xi < items.length; xi++) {
      if (rank[itemKey(items[xi])] !== undefined) known.push(items[xi]); else fresh.push(items[xi]);
    }
    known.sort(function (a, b) { return rank[itemKey(a)] - rank[itemKey(b)]; });
    fresh.sort(compareSessionListItems);
    items = fresh.concat(known);
    if (fresh.length) frozenOrder = fresh.map(itemKey).concat(frozenOrder);
  }

  var bookmarkedItems = [];
  var regularItems = [];
  for (var n = 0; n < items.length; n++) {
    var item = items[n];
    if (item.type === "session" && item.data && !isSessionVisibleBySearch(item.data.id)) {
      continue;
    }
    if (item.type === "session" && item.data && item.data.bookmarked) {
      bookmarkedItems.push(item);
    } else {
      regularItems.push(item);
    }
  }

  // Date-group headers are derived from each item's live lastActivity, but the
  // item order is otherwise frozen for stability (items don't jump as you use
  // them). When an item's day tier changes without a re-sort — e.g. a session
  // becomes "Today" after you open it while still sitting below yesterday's
  // items in the frozen order — the headers would render out of chronological
  // order ("Yesterday" above "Today"), or even emit a duplicate header for a
  // non-contiguous tier. Stably bucket into canonical tier order while keeping
  // the frozen order within each tier, so groups are always contiguous and
  // descending in recency.
  var GROUP_RANK = { "Today": 0, "Yesterday": 1, "This Week": 2, "Older": 3 };
  var tierBuckets = [[], [], [], []];
  for (var tb = 0; tb < regularItems.length; tb++) {
    var tierRank = GROUP_RANK[getDateGroup(regularItems[tb].lastActivity || 0)];
    if (tierRank === undefined) tierRank = 3;
    tierBuckets[tierRank].push(regularItems[tb]);
  }
  regularItems = tierBuckets[0].concat(tierBuckets[1], tierBuckets[2], tierBuckets[3]);

  var favoritesContainer = document.createElement("div");
  favoritesContainer.className = "session-favorites-section";
  setupBookmarkDropTarget(favoritesContainer, true);
  if (bookmarkedItems.length === 0) {
    var emptyHint = document.createElement("div");
    emptyHint.className = "session-favorites-empty";
    emptyHint.textContent = "Drag and drop sessions here to add favorites.";
    favoritesContainer.appendChild(emptyHint);
  }
  for (var bi = 0; bi < bookmarkedItems.length; bi++) {
    favoritesContainer.appendChild(renderSessionItem(bookmarkedItems[bi].data));
  }

  var divider = document.createElement("div");
  divider.className = "session-favorites-divider";

  var regularContainer = document.createElement("div");
  regularContainer.className = "session-regular-drop";
  setupBookmarkDropTarget(regularContainer, false);
  var stickyTop = document.createElement("div");
  stickyTop.className = "session-list-sticky-top";
  stickyTop.appendChild(favoritesContainer);
  stickyTop.appendChild(divider);
  stickyTop.appendChild(renderSessionTopActions(getTopActionDeps()));
  getSessionListEl().appendChild(stickyTop);

  var currentGroup = "";
  var currentGroupIds = [];
  for (var ri = 0; ri < regularItems.length; ri++) {
    var item = regularItems[ri];
    var group = getDateGroup(item.lastActivity || 0);
    if (group !== currentGroup) {
      currentGroup = group;
      currentGroupIds = [];
      for (var gi = ri; gi < regularItems.length; gi++) {
        if (getDateGroup(regularItems[gi].lastActivity || 0) !== group) break;
        var groupIds = collectItemSessionIds(regularItems[gi]);
        for (var gj = 0; gj < groupIds.length; gj++) currentGroupIds.push(groupIds[gj]);
      }
      regularContainer.appendChild(createSessionGroupHeader(group, currentGroupIds));
    }
    if (item.type === "loop") {
      var loopEl = renderLoopGroup(item.loopId, item.children, item.groupKey, getLoopRenderDeps());
      if (loopEl) {
        regularContainer.appendChild(loopEl);
      }
    } else {
      regularContainer.appendChild(renderSessionItem(item.data));
    }
  }
  getSessionListEl().appendChild(regularContainer);
  refreshIcons();
  if (updatePageTitle) updatePageTitle();
  syncSessionHeaderSearchUi(getHeaderSearchDeps());
  // Re-insert the schedule countdown immediately after a rebuild so an enabled
  // auto-launcher never blinks out (instead of waiting up to 1s for the timer).
  updateCountdowns();
}

// --- Search results ---

export function handleSearchResults(msg) {
  if (msg.query !== searchQuery) return; // stale response
  var ids = new Set();
  for (var i = 0; i < msg.results.length; i++) {
    ids.add(msg.results[i].id);
  }
  searchMatchIds = ids;
  renderSessionList(null);
}

// --- CLI session picker ---

function relativeTime(isoString) {
  if (!isoString) return "";
  var ms = Date.now() - new Date(isoString).getTime();
  var sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  var min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  var days = Math.floor(hr / 24);
  if (days < 30) return days + "d ago";
  return new Date(isoString).toLocaleDateString();
}
