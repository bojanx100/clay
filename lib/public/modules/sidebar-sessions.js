// sidebar-sessions.js - Session list, search, presence, countdown, CLI picker
// Extracted from sidebar.js (PR-35)

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
import { coordinatorWorkerDisplay, createCoordinatorWorkersToggle } from './sidebar-coordinator-workers.js';
import {
  buildGlobalCoopDisplayModel,
  globalCoopProjectionSignature,
} from './global-coop-projection.js';
import { renderCoopTopicSections } from './sidebar-coop-topics.js';
import { actionQueueSignature, nowIndexSignature } from './coop-action-queue-ui.js';
import { switchProject, openResolvedGlobalSession } from './app-projects.js';
import { topicLinksSignature } from './sidebar-coop-topic-links.js';
import { VENDOR_ORDER } from './vendor-ui.js';
import {
  orchestrationParent as getOrchestrationParent,
  sessionListSignature,
  buildSessionListModel,
} from './sidebar-sessions-model.js';

export { openImportSessionPicker, handleCliSessionList, handleCliSessionImported };
export { updateSessionPresence, updateSessionBadge };
export { setAutoLaunchActivity, getAutoLaunchActivitySummary, openAutoLaunchActivity };
export { getDateGroup, highlightMatch };
export { openSessionActionMenu };


// --- Session state ---
var cachedSessions = [];
var cachedSessionsSlug = "";
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
  if (state.lastVendor !== prev.lastVendor || state.installedVendors !== prev.installedVendors) {
    _listSignature = null;
    if (!isSessionListLoading()) renderSessionList(null);
  }
  // activeCoopLensScope matters on its own: switching All -> Main changes no
  // lens ref at all (both are ref-less), so watching only activeCoopLens meant
  // the overview never repainted and Main could not be selected.
  if ((state.activeSessionId !== prev.activeSessionId ||
       state.sessionVendorOverrides !== prev.sessionVendorOverrides ||
       state.activeCoopLens !== prev.activeCoopLens ||
       state.activeCoopLensScope !== prev.activeCoopLensScope ||
       state.coopConversationState !== prev.coopConversationState ||
       state.coopActionQueue !== prev.coopActionQueue ||
       state.coopActionPending !== prev.coopActionPending ||
       state.coopActionError !== prev.coopActionError ||
       state.coopActionDone !== prev.coopActionDone ||
       state.coopDoneSectionOpen !== prev.coopDoneSectionOpen) &&
      cachedSessions.length > 0) {
    renderSessionList(null);
  }
});
function sessionVendorOverrideKey(sessionId, cliSessionId) {
  var slug = store.get('currentSlug') || "";
  return slug + ":" + (cliSessionId || ("local:" + sessionId));
}

export function getSessionProviderColorClass(s) {
  var vendorOverrides = store.get('sessionVendorOverrides') || {};
  var rememberedVendor = s.vendor ? "" : (vendorOverrides[sessionVendorOverrideKey(s.id, s.cliSessionId)] || "");
  var sessionVendor = s.vendor || rememberedVendor || "claude";
  return providerShortName(sessionVendor, s.providerRouteId || null, s.model || "").toLowerCase() === "codex" ? "codex" : "claude";
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

export function resolveDefaultVendor() {
  var installed = store.get('installedVendors') || [];
  var lastVendor = store.get('lastVendor') || "";
  if (lastVendor && installed.indexOf(lastVendor) !== -1) return lastVendor;
  for (var i = 0; i < VENDOR_ORDER.length; i++) {
    if (installed.indexOf(VENDOR_ORDER[i]) !== -1) return VENDOR_ORDER[i];
  }
  return "claude";
}

export function startNewSession(vendor, extra) {
  var payload = { type: "new_session", vendor: vendor };
  if (extra) payload = Object.assign(payload, extra);
  if (!sendUserAction(payload)) return false;
  store.set({
    lastVendor: vendor,
    currentVendor: vendor,
    currentModel: "",
    currentModels: [],
    vendorSelectionLocked: true,
  });
  return true;
}

export function isSessionListLoading() {
  return cachedSessionsSlug !== (store.get('currentSlug') || "");
}

export function prepareSessionListForProject(slug) {
  cachedSessions = [];
  cachedSessionsSlug = "";
  frozenOrder = null;
  frozenOrderSlug = null;
  _listSignature = null;
  if ((store.get('currentSlug') || "") === slug) renderSessionList(null);
}

if (typeof window !== "undefined") {
  window.addEventListener("clay:project-switching", function () {
    prepareSessionListForProject(store.get('currentSlug') || "");
  });
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
    resolveDefaultVendor: resolveDefaultVendor,
    startNewSession: startNewSession,
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

function createSessionItemElement(s) {
  var el = document.createElement("div");
  var isMatch = searchMatchIds !== null && searchMatchIds.has(s.id);
  el.className = "session-item" + (s.active ? " active" : "") + (isMatch ? " search-match" : "");
  el.dataset.sessionId = s.id;
  var orchestrationParent = getOrchestrationParent(s);
  if (orchestrationParent && orchestrationParent.workerColor) {
    el.style.setProperty("--worker-color", orchestrationParent.workerColor);
  }
  if (orchestrationParent && orchestrationParent.taskStatus) {
    el.classList.add("worker-status-" + orchestrationParent.taskStatus);
  }
  return el;
}

function sessionLeadingMarkup(s, parent) {
  var textHtml = "";
  if (s.loop && s.loop.source === "debate") {
    textHtml += '<span class="session-debate-icon" title="Debate">' + iconHtml("mic") + '</span>';
  }
  if (store.get('isMultiUserMode') && s.sessionVisibility === "private") {
    textHtml += '<span class="session-private-icon" title="Private session">' + iconHtml("lock") + '</span>';
  }
  if (s.leadOwned && !parent && !s.coopHome) {
    textHtml += '<span class="session-lead-glyph" role="img" aria-label="Lead-controlled session" title="Lead-controlled session">🧭</span>';
  }
  return textHtml;
}

function sessionWorkerVendorPresentation(parent) {
  var presentation = { classSuffix: "", titlePrefix: "" };
  if (!parent) return presentation;

  var titleParts = [];
  var attemptCount = Number(parent.attemptCount) || 0;
  if (attemptCount > 1) {
    titleParts.push("Worker attempt " + (Number(parent.attempt) || 0) + " of " + attemptCount);
  }
  if (parent.taskStatus) {
    presentation.classSuffix = " worker-status-" + parent.taskStatus;
    var taskStatusLabel = String(parent.taskStatus).replace(/_/g, " ");
    titleParts.push(taskStatusLabel.charAt(0).toUpperCase() + taskStatusLabel.slice(1));
  }
  if (titleParts.length) presentation.titlePrefix = titleParts.join(" · ") + " · ";
  return presentation;
}

function sessionVendorMarkup(s, parent) {
  if (s.coopHome) return "";
  var vendorOverrides = store.get('sessionVendorOverrides') || {};
  var rememberedVendor = s.vendor ? "" : (vendorOverrides[sessionVendorOverrideKey(s.id, s.cliSessionId)] || "");
  var sessionVendor = s.vendor || rememberedVendor || "claude";
  var dotVendor = getSessionProviderColorClass(s);
  var vendorDotClass = "session-vendor-dot " + dotVendor + (s.isProcessing ? " processing" : "");
  var vendorDotTitle = providerShortName(sessionVendor, s.providerRouteId || null, s.model || "") + " session";
  var workerPresentation = sessionWorkerVendorPresentation(parent);
  vendorDotClass += workerPresentation.classSuffix;
  vendorDotTitle = workerPresentation.titlePrefix + vendorDotTitle;
  return '<span class="' + vendorDotClass + '" title="' + vendorDotTitle + '" aria-label="' + vendorDotTitle + '"></span>';
}

function sessionAutoLaunchMarkup(s) {
  if (!s.taskLauncher || !s.taskLauncher.autoLaunch) return "";
  var isPrFix = s.taskLauncher.kind === "pr-review";
  var label = isPrFix ? "PR fix" : "Auto";
  var title = isPrFix ? "Auto-launched PR fix" : "Auto-launched task";
  return '<span class="session-auto-badge' + (isPrFix ? ' pr' : '') + '" title="' + title + '">' + label + '</span>';
}

function createSessionItemText(s, parent) {
  var textHtml = sessionLeadingMarkup(s, parent);
  textHtml += sessionVendorMarkup(s, parent);
  textHtml += sessionAutoLaunchMarkup(s);
  // Wrapped in its own span so consumers reading the plain session title
  // (e.g. updatePageTitle in sidebar.js) don't pick up the role/vendor/auto
  // badge text via .textContent -- those badges are adjacent siblings with
  // no whitespace in the markup, so a flat .textContent read would otherwise
  // glue e.g. "Coordinator" straight onto the title ("CoordinatorREDESIGN").
  textHtml += '<span class="session-item-title">' + highlightMatch(s.sidebarTitle || s.title || "New Session", searchQuery) + '</span>';
  return textHtml;
}

function appendSessionItemText(el, s, parent) {
  var textSpan = document.createElement("span");
  textSpan.className = "session-item-text";
  textSpan.innerHTML = createSessionItemText(s, parent);
  el.appendChild(textSpan);
}

function attachSessionContextMenu(el, s) {
  el.addEventListener("contextmenu", (function(id, title, cliSid, anchor, sData) {
    return function(e) {
      e.preventDefault();
      e.stopPropagation();
      showSessionCtxMenu(anchor, id, title, cliSid, sData);
    };
  })(s.id, s.title, s.cliSessionId, el, s));
}

function appendSessionUnreadBadge(el, s) {
  var unreadBadge = document.createElement("span");
  unreadBadge.className = "session-unread-badge";
  unreadBadge.dataset.sessionId = s.id;
  if (s.unread > 0) {
    unreadBadge.textContent = s.unread > 99 ? "99+" : String(s.unread);
    unreadBadge.classList.add("has-unread");
  }
  el.appendChild(unreadBadge);
}

function attachSessionClick(el, s) {
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
}

function renderSessionItem(s) {
  var el = createSessionItemElement(s);
  var parent = getOrchestrationParent(s);
  appendSessionItemText(el, s, parent);
  attachSessionContextMenu(el, s);
  appendSessionUnreadBadge(el, s);
  appendSessionCloseButton(el, s);
  attachSessionClick(el, s);
  renderPresenceAvatars(el, String(s.id));
  if (!s.coopHome && !s.coopChannel) setupSessionDragHandlers(el, s);
  return el;
}

function renderCoordinatorGroup(item) {
  var wrapper = document.createElement("div");
  wrapper.className = "session-coordinator-group";
  wrapper.dataset.coordinatorSessionId = item.data.id;
  var parentRow = renderSessionItem(item.data);
  parentRow.classList.add("session-coordinator-parent");
  wrapper.appendChild(parentRow);

  var children = document.createElement("div");
  children.className = "session-coordinator-workers";
  var matchingChildren = item.children.filter(function (child) {
    return isSessionVisibleBySearch(child.id);
  });
  var display = coordinatorWorkerDisplay(matchingChildren, item.data.id, searchMatchIds !== null);
  for (var i = 0; i < display.workers.length; i++) {
    var childRow = renderSessionItem(display.workers[i]);
    childRow.classList.add("session-coordinator-worker");
    children.appendChild(childRow);
  }
  if (searchMatchIds === null) {
    var toggle = createCoordinatorWorkersToggle(
      item.data.id,
      display,
      "session-coordinator-workers-toggle",
      function () { renderSessionList(null); }
    );
    if (toggle) children.appendChild(toggle);
  }
  wrapper.appendChild(children);
  return wrapper;
}

function createGlobalCoopConversationSection() {
  var section = document.createElement("div");
  section.className = "global-coop-conversations";
  renderCoopTopicSections(section, buildGlobalCoopDisplayModel(searchQuery), {
    mobile: false,
    onToggle: function () { renderSessionList(null); },
    // The action queue navigates; this surface owns the app-graph imports so the
    // queue module itself can stay dependency-light.
    openSession: openResolvedGlobalSession,
    openProject: switchProject,
  });
  return section;
}

// --- Main session list ---

function updateActiveHighlight() {
  var listEl = getSessionListEl();
  if (!listEl) return;
  var activeId = String(store.get('activeSessionId') || "");
  var rows = listEl.querySelectorAll('.session-item[data-session-id], .session-loop-child[data-session-id]');
  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("active", rows[i].dataset.sessionId === activeId);
  }
}

function currentSessionListSignature() {
  var signature = sessionListSignature(
    cachedSessions,
    searchQuery,
    searchMatchIds,
    store.get("expandedCoordinatorWorkerGroups") || {},
    expandedLoopGroups,
    expandedLoopRuns
  );
  // The lens SCOPE belongs in the signature, not just the lens ref. Main and
  // All are both ref-less, so switching between them left this string
  // identical and canSkipSessionListRender treated the rebuild as redundant --
  // the overview never repainted, and Main could not be selected.
  return store.get('currentSlug') === "lead"
    ? signature + "|" + globalCoopProjectionSignature() + "|" +
      JSON.stringify(store.get("activeCoopLens") || null) + "|" +
      String(store.get("activeCoopLensScope") || "") + "|" + topicLinksSignature() +
      "|" + actionQueueSignature() + "|" + nowIndexSignature() + "|" +
      JSON.stringify(store.get("coopConversationState") || null)
    : signature;
}

function canSkipSessionListRender(sig, listEl) {
  return sig === _listSignature && listEl && listEl.children.length > 0;
}

function buildCurrentSessionListModel() {
  var model = buildSessionListModel(cachedSessions, {
    currentSlug: store.get('currentSlug') || "",
    frozenOrder: frozenOrder,
    frozenOrderSlug: frozenOrderSlug,
    getDateGroup: getDateGroup,
    searchMatchIds: searchMatchIds,
  });
  frozenOrder = model.frozenOrder;
  frozenOrderSlug = model.frozenOrderSlug;
  return model;
}

function appendSessionItemForType(container, item) {
  if (item.type === "loop") {
    var loopEl = renderLoopGroup(item.loopId, item.children, item.groupKey, getLoopRenderDeps());
    if (loopEl) container.appendChild(loopEl);
    return;
  }
  if (item.type === "coordinator") {
    container.appendChild(renderCoordinatorGroup(item));
    return;
  }
  container.appendChild(renderSessionItem(item.data));
}

function createFavoritesContainer(bookmarkedItems) {
  var favoritesContainer = document.createElement("div");
  favoritesContainer.className = "session-favorites-section";
  setupBookmarkDropTarget(favoritesContainer, true);
  if (bookmarkedItems.length === 0) {
    var emptyHint = document.createElement("div");
    emptyHint.className = "session-favorites-empty";
    emptyHint.textContent = "Drag and drop sessions here to add favorites.";
    favoritesContainer.appendChild(emptyHint);
  }
  for (var i = 0; i < bookmarkedItems.length; i++) {
    appendSessionItemForType(favoritesContainer, bookmarkedItems[i]);
  }
  return favoritesContainer;
}

function createStickyTop(bookmarkedItems) {
  var divider = document.createElement("div");
  divider.className = "session-favorites-divider";
  var stickyTop = document.createElement("div");
  stickyTop.className = "session-list-sticky-top";
  stickyTop.appendChild(createFavoritesContainer(bookmarkedItems));
  stickyTop.appendChild(divider);
  stickyTop.appendChild(renderSessionTopActions(getTopActionDeps()));
  return stickyTop;
}

function appendDateGroup(container, group) {
  var protectedIds = {};
  for (var si = 0; si < cachedSessions.length; si++) {
    if (cachedSessions[si].coopHome || cachedSessions[si].coopChannel) protectedIds[cachedSessions[si].id] = true;
  }
  var deletableIds = group.sessionIds.filter(function (id) { return !protectedIds[id]; });
  container.appendChild(createSessionGroupHeader(group.name, deletableIds));
  for (var i = 0; i < group.items.length; i++) {
    appendSessionItemForType(container, group.items[i]);
  }
}

function createOwnershipSection(section) {
  var sectionEl = document.createElement("section");
  sectionEl.className = "session-ownership-section session-ownership-section-" + section.key;
  var header = document.createElement("div");
  header.className = "session-ownership-header";
  header.setAttribute("role", "heading");
  header.setAttribute("aria-level", "2");
  header.textContent = section.label;
  sectionEl.appendChild(header);
  for (var i = 0; i < section.dateGroups.length; i++) appendDateGroup(sectionEl, section.dateGroups[i]);
  return sectionEl;
}

function createRegularContainer(ownershipSections) {
  var regularContainer = document.createElement("div");
  regularContainer.className = "session-regular-drop";
  setupBookmarkDropTarget(regularContainer, false);
  for (var i = 0; i < ownershipSections.length; i++) {
    regularContainer.appendChild(createOwnershipSection(ownershipSections[i]));
  }
  return regularContainer;
}

function finishSessionListRender() {
  refreshIcons();
  if (updatePageTitle) updatePageTitle();
  syncSessionHeaderSearchUi(getHeaderSearchDeps());
  // Lead is a global delegator surface. Its sidebar contains only Coop and
  // bounded project channels, never local scheduled-work rows.
  if (store.get("currentSlug") !== "lead") updateCountdowns();
}

export function renderSessionList(sessions) {
  var currentSlug = store.get('currentSlug') || "";
  if (sessions) {
    cachedSessions = sessions;
    cachedSessionsSlug = currentSlug;
  }
  if (refreshMobileChatSheet) refreshMobileChatSheet();

  var listEl = getSessionListEl();
  var sig = currentSessionListSignature();
  if (canSkipSessionListRender(sig, listEl)) {
    updateActiveHighlight();
    return;
  }
  _listSignature = sig;

  listEl.innerHTML = "";
  if (isSessionListLoading()) {
    var loading = document.createElement("div");
    loading.className = "session-list-target-loading";
    loading.dataset.projectSlug = currentSlug;
    loading.textContent = "Loading conversations…";
    listEl.appendChild(loading);
    finishSessionListRender();
    return;
  }
  if (store.get('currentSlug') === "lead") {
    listEl.appendChild(createGlobalCoopConversationSection());
    finishSessionListRender();
    return;
  }

  var model = buildCurrentSessionListModel();
  listEl.appendChild(createStickyTop(model.bookmarkedItems));
  listEl.appendChild(createRegularContainer(model.ownershipSections));
  finishSessionListRender();
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
