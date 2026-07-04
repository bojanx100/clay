// sidebar-sessions.js - Session list, search, presence, countdown, CLI picker
// Extracted from sidebar.js (PR-35)

import { escapeHtml, showToast } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { openSearch as openSessionSearch } from './session-search.js';
import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { sendUserAction } from './app-connection.js';
import { getSessionListEl } from './dom-refs.js';
import { dismissOverlayPanels, closeSidebar, updatePageTitle, spawnDustParticles } from './sidebar.js';
import { showConfirm } from './app-misc.js';
import { refreshMobileChatSheet } from './sidebar-mobile.js';
import { getCachedProjects } from './app-projects.js';
import { providerShortName } from './provider-route-ui.js';
import { openImportSessionPicker, handleCliSessionList, handleCliSessionImported } from './sidebar-sessions-import.js';
import { initSessionHeaderSearch, syncSessionHeaderSearchUi } from './sidebar-sessions-header-search.js';
import { renderPresenceAvatars, updateSessionPresence, updateSessionBadge } from './sidebar-sessions-presence.js';
import { startCountdownTimer, updateCountdowns, setAutoLaunchActivity, getAutoLaunchActivitySummary, openAutoLaunchActivity } from './sidebar-sessions-countdown.js';
import { startInlineRename, startLoopInlineRename } from './sidebar-sessions-rename.js';
import { getDateGroup, highlightMatch } from './sidebar-sessions-groups.js';

export { openImportSessionPicker, handleCliSessionList, handleCliSessionImported };
export { updateSessionPresence, updateSessionBadge };
export { setAutoLaunchActivity, getAutoLaunchActivitySummary, openAutoLaunchActivity };
export { getDateGroup, highlightMatch };


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

// --- Session context menu ---
var sessionCtxMenu = null;
var sessionCtxSessionId = null;
var draggedSessionId = null;

store.subscribe(function (state, prev) {
  if ((state.activeSessionId !== prev.activeSessionId ||
       state.sessionVendorOverrides !== prev.sessionVendorOverrides) &&
      cachedSessions.length > 0) {
    renderSessionList(null);
  }
});
var draggedSessionBookmarked = false;
var armedDeleteSessionId = null;
var armedDeleteTimer = null;

function sessionVendorOverrideKey(sessionId, cliSessionId) {
  var slug = store.get('currentSlug') || "";
  return slug + ":" + (cliSessionId || ("local:" + sessionId));
}

function sendSessionBookmark(sessionId, bookmarked) {
  sendUserAction({ type: "set_session_bookmark", sessionId: sessionId, bookmarked: !!bookmarked });
}

function vendorLabel(vendor) {
  if (vendor === "codex") return "Codex via OpenAI";
  if (vendor === "github-copilot") return "GitHub Copilot";
  return "Claude via Anthropic";
}

function routeStatusText(route) {
  if (!route) return "Not available";
  if (route.enabled) return "Available";
  if (route.setup) return route.setup;
  if (route.installed) return "Installed but unavailable";
  return "CLI not installed";
}

function inferCurrentRouteId(currentVendor, currentRouteId) {
  if (currentRouteId) return currentRouteId;
  if (currentVendor === "claude") return "claude-anthropic";
  if (currentVendor === "codex") return "codex-openai";
  return null;
}

function concreteSessionModel(sessionData) {
  if (!sessionData) return "";
  var candidates = [
    sessionData.verifiedModel,
    sessionData.requestedModel,
    sessionData.model
  ];
  for (var i = 0; i < candidates.length; i++) {
    var model = candidates[i];
    if (model && model !== "default" && model !== "auto") return model;
  }
  return "";
}

function getRoutesForSessionMenu(currentVendor, currentRouteId) {
  var routes = store.get('providerRoutes') || [];
  if (routes.length > 0) {
    var collapsed = [];
    var copilotRoute = null;
    for (var ri = 0; ri < routes.length; ri++) {
      var route = routes[ri];
      if (!route) continue;
      if (route.vendor === "github-copilot") {
        if (!copilotRoute) {
          copilotRoute = {
            id: null,
            vendor: "github-copilot",
            label: "GitHub Copilot",
            enabled: !!route.enabled,
            installed: !!route.installed,
            setup: route.setup,
          };
        } else {
          copilotRoute.enabled = copilotRoute.enabled || !!route.enabled;
          copilotRoute.installed = copilotRoute.installed || !!route.installed;
          if (!copilotRoute.setup && route.setup) copilotRoute.setup = route.setup;
        }
      } else {
        collapsed.push(route);
      }
    }
    if (copilotRoute) collapsed.push(copilotRoute);
    return collapsed;
  }
  var installed = store.get('installedVendors') || [];
  var resolvedRouteId = inferCurrentRouteId(currentVendor, currentRouteId);
  return [
    {
      id: "claude-anthropic",
      vendor: "claude",
      label: "Claude via Anthropic",
      enabled: resolvedRouteId !== "claude-anthropic" && installed.indexOf("claude") !== -1,
      installed: installed.indexOf("claude") !== -1,
    },
    {
      id: "codex-openai",
      vendor: "codex",
      label: "Codex via OpenAI",
      enabled: resolvedRouteId !== "codex-openai" && installed.indexOf("codex") !== -1,
      installed: installed.indexOf("codex") !== -1,
    },
    {
      id: null,
      vendor: "github-copilot",
      label: "GitHub Copilot",
      enabled: currentVendor !== "github-copilot" && installed.indexOf("github-copilot") !== -1,
      installed: installed.indexOf("github-copilot") !== -1,
      setup: "Install GitHub Copilot CLI, then run copilot login.",
    },
  ];
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

function clearSessionDragIndicators() {
  var listEl = getSessionListEl();
  if (!listEl) return;
  var active = listEl.querySelectorAll(".session-favorites-divider.drag-hover, .session-regular-drop.drag-hover, .session-item.dragging");
  for (var i = 0; i < active.length; i++) {
    active[i].classList.remove("drag-hover", "dragging");
  }
}

function setupSessionDragHandlers(el, session) {
  el.setAttribute("draggable", "true");

  el.addEventListener("dragstart", function (e) {
    draggedSessionId = session.id;
    draggedSessionBookmarked = !!session.bookmarked;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(session.id));

    var ghost = document.createElement("div");
    ghost.textContent = session.title || "New Session";
    ghost.style.cssText = "position:fixed;left:-200px;top:-200px;max-width:220px;padding:8px 12px;border-radius:10px;" +
      "background:var(--sidebar-active);color:var(--text);font-size:13px;font-weight:600;pointer-events:none;z-index:-1;";
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 18, 18);
    setTimeout(function () { ghost.remove(); }, 0);

    setTimeout(function () { el.classList.add("dragging"); }, 0);
  });

  el.addEventListener("dragend", function () {
    clearSessionDragIndicators();
    draggedSessionId = null;
    draggedSessionBookmarked = false;
  });

  if (session.bookmarked) {
    el.addEventListener("dragover", function (e) {
      if (!draggedSessionId || draggedSessionId === session.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      var rect = el.getBoundingClientRect();
      var insertBefore = e.clientY < rect.top + rect.height / 2;
      el.classList.remove("drag-over-above", "drag-over-below");
      el.classList.add(insertBefore ? "drag-over-above" : "drag-over-below");
    });

    el.addEventListener("dragleave", function () {
      el.classList.remove("drag-over-above", "drag-over-below");
    });

    el.addEventListener("drop", function (e) {
      if (!draggedSessionId || draggedSessionId === session.id) return;
      e.preventDefault();
      var rect = el.getBoundingClientRect();
      var insertBefore = e.clientY < rect.top + rect.height / 2;
      el.classList.remove("drag-over-above", "drag-over-below");
      if (draggedSessionBookmarked) {
        sendUserAction({
          type: "reorder_session_bookmarks",
          sourceId: draggedSessionId,
          targetId: session.id,
          insertBefore: insertBefore,
        });
      } else {
        sendSessionBookmark(draggedSessionId, true);
      }
    });
  }
}

function setupBookmarkDropTarget(el, bookmarked) {
  el.addEventListener("dragover", function (e) {
    if (!draggedSessionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drag-hover");
  });

  el.addEventListener("dragleave", function () {
    el.classList.remove("drag-hover");
  });

  el.addEventListener("drop", function (e) {
    if (!draggedSessionId) return;
    e.preventDefault();
    el.classList.remove("drag-hover");
    if (draggedSessionBookmarked !== !!bookmarked) {
      sendSessionBookmark(draggedSessionId, !!bookmarked);
    }
    clearSessionDragIndicators();
    draggedSessionId = null;
    draggedSessionBookmarked = false;
  });
}

function spawnSessionDeleteParticles(sessionId) {
  if (!spawnDustParticles) return;
  setTimeout(function () {
    var el = getSessionListEl().querySelector('[data-session-id="' + sessionId + '"]');
    if (!el) return;
    var rect = el.getBoundingClientRect();
    spawnDustParticles(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, 0);
}

function confirmDeleteSession(session) {
  showConfirm('Delete "' + (session.title || "New Session") + '"? This session and its history will be permanently removed.', function () {
    if (sendUserAction({ type: "delete_session", id: session.id })) {
      spawnSessionDeleteParticles(session.id);
    }
  });
}

function clearArmedSessionDelete() {
  if (armedDeleteTimer) {
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = null;
  }
  if (armedDeleteSessionId !== null) {
    var prevBtn = getSessionListEl() ? getSessionListEl().querySelector('.session-close-btn[data-session-id="' + armedDeleteSessionId + '"]') : null;
    if (prevBtn) {
      prevBtn.classList.remove("armed");
      prevBtn.innerHTML = iconHtml("x");
      prevBtn.title = "Delete session";
      prevBtn.setAttribute("aria-label", "Delete session");
      refreshIcons();
    }
  }
  armedDeleteSessionId = null;
}

function armSessionDelete(closeBtn, session) {
  clearArmedSessionDelete();
  armedDeleteSessionId = session.id;
  closeBtn.classList.add("armed");
  closeBtn.innerHTML = iconHtml("check");
  closeBtn.title = "Click again to hide";
  closeBtn.setAttribute("aria-label", "Click again to hide");
  refreshIcons();
  armedDeleteTimer = setTimeout(function () {
    clearArmedSessionDelete();
  }, 1800);
}

function deleteSessionImmediately(session) {
  if (sendUserAction({ type: "hide_session", id: session.id })) {
    spawnSessionDeleteParticles(session.id);
  }
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

function confirmDeleteSessionGroup(groupLabel, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return;
  var count = sessionIds.length;
  var noun = count === 1 ? "session" : "sessions";
  showConfirm('Clear "' + groupLabel + '"? ' + count + " " + noun + ' will be permanently removed.', function () {
    sendUserAction({ type: "bulk_delete_sessions", sessionIds: sessionIds });
  });
}

function createSessionGroupHeader(group, sessionIds) {
  var header = document.createElement("div");
  header.className = "session-group-header";

  var label = document.createElement("span");
  label.className = "session-group-header-label";
  label.textContent = group;
  header.appendChild(label);

  if ((!store.get('permissions') || store.get('permissions').sessionDelete !== false) && Array.isArray(sessionIds) && sessionIds.length > 0) {
    var clearBtn = document.createElement("button");
    clearBtn.className = "session-group-clear-btn";
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      confirmDeleteSessionGroup(group, sessionIds);
    });
    header.appendChild(clearBtn);
  }

  return header;
}

function appendSessionCloseButton(el, session) {
  if (store.get('permissions') && store.get('permissions').sessionDelete === false) return;

  var closeBtn = document.createElement("button");
  closeBtn.className = "session-close-btn";
  closeBtn.dataset.sessionId = session.id;
  closeBtn.type = "button";
  closeBtn.title = "Hide session";
  closeBtn.setAttribute("aria-label", "Hide session");
  closeBtn.innerHTML = iconHtml("x");
  closeBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (armedDeleteSessionId === session.id) {
      clearArmedSessionDelete();
      deleteSessionImmediately(session);
      return;
    }
    armSessionDelete(closeBtn, session);
  });
  el.appendChild(closeBtn);
}

function renderSessionTopActions() {
  var wrap = document.createElement("div");
  wrap.className = "session-top-actions";

  // Claude: split button. The main button creates a session using the user's
  // claudeOpenMode pref (server applies it). The chevron opens a menu with
  // alternate launch modes (e.g. bypass-permissions, TUI shell only).
  var claudeCell = document.createElement("div");
  claudeCell.className = "session-top-action-split";

  var claudeBtn = document.createElement("button");
  claudeBtn.className = "session-top-action split-main";
  claudeBtn.type = "button";
  claudeBtn.title = "New Claude session";
  claudeBtn.innerHTML = '<img src="/claude-code-avatar.png" class="session-top-action-icon" alt=""><span>Claude</span>';
  claudeBtn.addEventListener("click", function () {
    sendUserAction({ type: "new_session", vendor: "claude" });
  });
  claudeCell.appendChild(claudeBtn);

  var claudeChevron = document.createElement("button");
  claudeChevron.className = "session-top-action split-chevron";
  claudeChevron.type = "button";
  claudeChevron.title = "More Claude launch options";
  claudeChevron.setAttribute("aria-label", "More Claude launch options");
  claudeChevron.innerHTML = iconHtml("chevron-down");
  claudeChevron.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (sessionCtxMenu) { closeSessionCtxMenu(); return; }
    showClaudeStartMenu(claudeChevron);
  });
  claudeCell.appendChild(claudeChevron);

  wrap.appendChild(claudeCell);

  // Codex: always GUI (no TUI adapter for Codex). Split button mirrors the
  // Claude one so launch extras (currently: Import session...) live behind a
  // chevron instead of cluttering the primary action.
  var codexCell = document.createElement("div");
  codexCell.className = "session-top-action-split";

  var codexBtn = document.createElement("button");
  codexBtn.className = "session-top-action split-main";
  codexBtn.type = "button";
  codexBtn.title = "New Codex session";
  codexBtn.innerHTML = '<img src="/codex-avatar.png" class="session-top-action-icon" alt=""><span>Codex</span>';
  codexBtn.addEventListener("click", function () {
    sendUserAction({ type: "new_session", vendor: "codex" });
  });
  codexCell.appendChild(codexBtn);

  var codexChevron = document.createElement("button");
  codexChevron.className = "session-top-action split-chevron";
  codexChevron.type = "button";
  codexChevron.title = "More Codex launch options";
  codexChevron.setAttribute("aria-label", "More Codex launch options");
  codexChevron.innerHTML = iconHtml("chevron-down");
  codexChevron.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (sessionCtxMenu) { closeSessionCtxMenu(); return; }
    showCodexStartMenu(codexChevron);
  });
  codexCell.appendChild(codexChevron);

  wrap.appendChild(codexCell);

  return wrap;
}

function showCodexStartMenu(anchorBtn) {
  closeSessionCtxMenu();

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var importItem = document.createElement("button");
  importItem.className = "session-ctx-item";
  importItem.innerHTML = iconHtml("download") + " <span>Import session...</span>";
  importItem.title = "Pick a Codex or GitHub Copilot Codex session to bring into Clay (includes closed/archived sessions)";
  importItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    openImportSessionPicker("codex");
  });
  menu.appendChild(importItem);

  document.body.appendChild(menu);
  sessionCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var btnRect = anchorBtn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = (btnRect.bottom + 2) + "px";
    menu.style.left = btnRect.left + "px";
    menu.style.right = "auto";
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = "auto";
      menu.style.right = (window.innerWidth - btnRect.right) + "px";
    }
  });
}

// Dropdown anchored to the Claude split-button chevron. Reuses the
// session-ctx-menu element/var so the global document click handler closes it.
function showClaudeStartMenu(anchorBtn) {
  closeSessionCtxMenu();

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var skipItem = document.createElement("button");
  skipItem.className = "session-ctx-item";
  skipItem.innerHTML = iconHtml("shield-off") + " <span>Skip permissions (TUI)</span>";
  skipItem.title = "Start a terminal session with --dangerously-skip-permissions";
  skipItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    sendUserAction({
      type: "new_session",
      vendor: "claude",
      mode: "tui",
      dangerouslySkipPermissions: true,
    });
  });
  menu.appendChild(skipItem);

  var importItem = document.createElement("button");
  importItem.className = "session-ctx-item";
  importItem.innerHTML = iconHtml("download") + " <span>Import session...</span>";
  importItem.title = "Pick a Claude or GitHub Copilot Claude session to bring into Clay (includes closed/archived sessions)";
  importItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    openImportSessionPicker("claude");
  });
  menu.appendChild(importItem);

  document.body.appendChild(menu);
  sessionCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var btnRect = anchorBtn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = (btnRect.bottom + 2) + "px";
    menu.style.left = btnRect.left + "px";
    menu.style.right = "auto";
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = "auto";
      menu.style.right = (window.innerWidth - btnRect.right) + "px";
    }
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (btnRect.top - menuRect.height - 2) + "px";
    }
  });
}

// --- Move-session-to-project picker ----------------------------------------

var movePickerEl = null;

function closeMoveProjectPicker() {
  if (movePickerEl && movePickerEl.parentNode) movePickerEl.parentNode.removeChild(movePickerEl);
  movePickerEl = null;
}

function openMoveProjectPicker(sessionId, sessionTitle, projects) {
  closeMoveProjectPicker();

  var overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center";

  var modal = document.createElement("div");
  modal.style.cssText = "background:var(--bg-alt);color:var(--text);border:1px solid var(--border);border-radius:10px;width:380px;max-width:90vw;max-height:70vh;display:flex;flex-direction:column;overflow:hidden";

  var header = document.createElement("div");
  header.style.cssText = "padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between";
  header.innerHTML = '<strong>Move session to\u2026</strong>';
  var closeBtn = document.createElement("button");
  closeBtn.textContent = "\xd7";
  closeBtn.style.cssText = "background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;padding:0 4px";
  closeBtn.addEventListener("click", closeMoveProjectPicker);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  var subheading = document.createElement("div");
  subheading.style.cssText = "padding:8px 16px 6px;font-size:12px;color:var(--text-dim)";
  subheading.textContent = "\u201c" + sessionTitle + "\u201d will be removed from this project and added to the selected one.";
  modal.appendChild(subheading);

  var body = document.createElement("div");
  body.style.cssText = "padding:8px;overflow-y:auto;flex:1";
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    var row = document.createElement("button");
    row.type = "button";
    row.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;border-radius:7px;color:var(--text);padding:9px 12px;cursor:pointer;font:inherit";
    row.addEventListener("mouseover", function () { this.style.background = "var(--sidebar-hover)"; });
    row.addEventListener("mouseout", function () { this.style.background = "none"; });
    var icon = p.icon ? '<span style="font-size:16px">' + escapeHtml(p.icon) + '</span>' : '<span style="opacity:0.4">' + iconHtml("folder") + '</span>';
    row.innerHTML = icon + '<span>' + escapeHtml(p.title || p.slug) + '</span>';
    (function (targetSlug, btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true;
        btn.style.opacity = "0.5";
        sendUserAction({ type: "move_session_to_project", id: sessionId, toSlug: targetSlug });
        closeMoveProjectPicker();
      });
    })(p.slug, row);
    body.appendChild(row);
  }
  modal.appendChild(body);

  overlay.appendChild(modal);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeMoveProjectPicker(); });
  document.body.appendChild(overlay);
  movePickerEl = overlay;
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

// --- Context menu ---

function closeSessionCtxMenu() {
  if (sessionCtxMenu) {
    sessionCtxMenu.remove();
    sessionCtxMenu = null;
    sessionCtxSessionId = null;
  }
}

function showSessionCtxMenu(anchorBtn, sessionId, title, cliSid, sessionData) {
  closeSessionCtxMenu();
  sessionCtxSessionId = sessionId;

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var bookmarkItem = document.createElement("button");
  bookmarkItem.className = "session-ctx-item";
  bookmarkItem.innerHTML = iconHtml(sessionData && sessionData.bookmarked ? "arrow-down" : "arrow-up") + " <span>" + (sessionData && sessionData.bookmarked ? "Remove from Favorites" : "Add to Favorites") + "</span>";
  bookmarkItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    sendSessionBookmark(sessionId, !(sessionData && sessionData.bookmarked));
  });
  menu.appendChild(bookmarkItem);

  var renameItem = document.createElement("button");
  renameItem.className = "session-ctx-item";
  renameItem.innerHTML = iconHtml("pencil") + " <span>Rename</span>";
  renameItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    startInlineRename(sessionId, title);
  });
  menu.appendChild(renameItem);

  // Session visibility toggle (only the session owner can change)
  if (store.get('isMultiUserMode') && sessionData && sessionData.ownerId && sessionData.ownerId === store.get('myUserId')) {
    var currentVis = (sessionData && sessionData.sessionVisibility) || "shared";
    var isPrivate = currentVis === "private";
    var visItem = document.createElement("button");
    visItem.className = "session-ctx-item";
    visItem.innerHTML = iconHtml(isPrivate ? "eye" : "eye-off") + " <span>" + (isPrivate ? "Make Shared" : "Make Private") + "</span>";
    visItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSessionCtxMenu();
      var newVis = isPrivate ? "shared" : "private";
      sendUserAction({ type: "set_session_visibility", sessionId: sessionId, visibility: newVis });
    });
    menu.appendChild(visItem);
  }

  if (!store.get('permissions') || store.get('permissions').sessionDelete !== false) {
    // Move to another project (only when other non-mate projects exist)
    var allProjects = getCachedProjects();
    var currentSlug = store.get('currentSlug');
    var moveTargets = [];
    for (var mpi = 0; mpi < allProjects.length; mpi++) {
      if (!allProjects[mpi].isMate && allProjects[mpi].slug !== currentSlug) moveTargets.push(allProjects[mpi]);
    }
    if (moveTargets.length > 0) {
      var moveItem = document.createElement("button");
      moveItem.className = "session-ctx-item";
      moveItem.innerHTML = iconHtml("folder-input") + " <span>Move to project\u2026</span>";
      moveItem.addEventListener("click", function (e) {
        e.stopPropagation();
        closeSessionCtxMenu();
        openMoveProjectPicker(sessionId, title, moveTargets);
      });
      menu.appendChild(moveItem);
    }

    var deleteItem = document.createElement("button");
    deleteItem.className = "session-ctx-item session-ctx-delete";
    deleteItem.innerHTML = iconHtml("trash-2") + " <span>Delete</span>";
    deleteItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSessionCtxMenu();
      confirmDeleteSession({ id: sessionId, title: title });
    });
    menu.appendChild(deleteItem);
  }

  // Vendor handoff: continue through another provider route
  var currentVendor = (sessionData && sessionData.vendor) || "claude";
  var currentRouteId = (sessionData && sessionData.providerRouteId) || null;
  var resolvedRouteId = inferCurrentRouteId(currentVendor, currentRouteId);
  var routes = getRoutesForSessionMenu(currentVendor, currentRouteId);
  for (var ri = 0; ri < routes.length; ri++) {
    var route = routes[ri];
    if (!route) continue;
    if (route.id && route.id === resolvedRouteId) continue;
    if (!route.id && route.vendor === currentVendor) continue;
    var handoffItem = document.createElement("button");
    handoffItem.className = "session-ctx-item session-ctx-handoff" + (route.enabled ? "" : " disabled");
    handoffItem.innerHTML = iconHtml("arrow-right-left") + " <span>Switch to " + escapeHtml(route.label || vendorLabel(route.vendor)) + "</span>";
    handoffItem.title = routeStatusText(route);
    handoffItem.addEventListener("click", (function(routeForClick) {
      return function(e) {
        e.stopPropagation();
        if (!routeForClick.enabled) {
          showToast(routeStatusText(routeForClick), "warn");
          return;
        }
        closeSessionCtxMenu();
        var routeLabelForConfirm = routeForClick.label || vendorLabel(routeForClick.vendor);
        // Confirm before a destructive provider switch (resets native session,
        // continues from a text-only handoff summary). Tag the source so the
        // recorded handoff says where it came from.
        showConfirm(
          "Switch this session to " + routeLabelForConfirm + "? This resets the provider's native session — the conversation continues from a text-only handoff summary, and pasted images won't carry over.",
          function () {
            var targetModel = concreteSessionModel(sessionData);
            sendUserAction({ type: "handoff_session", sessionId: sessionId, targetVendor: routeForClick.vendor, targetRouteId: routeForClick.id || null, targetModel: targetModel, source: "sidebar-menu" });
          },
          "Switch provider",
          false
        );
      };
    })(route));
    menu.appendChild(handoffItem);
  }

  document.body.appendChild(menu);
  sessionCtxMenu = menu;
  refreshIcons();

  // Position: fixed relative to the anchor button
  requestAnimationFrame(function () {
    var btnRect = anchorBtn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = (btnRect.bottom + 2) + "px";
    menu.style.right = (window.innerWidth - btnRect.right) + "px";
    menu.style.left = "auto";
    // If menu overflows below viewport, flip up
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (btnRect.top - menuRect.height - 2) + "px";
    }
  });
}

export function openSessionActionMenu(anchorBtn, sessionData) {
  if (!sessionData) return;
  showSessionCtxMenu(anchorBtn, sessionData.id, sessionData.title, sessionData.cliSessionId, sessionData);
}

function showLoopCtxMenu(anchorBtn, loopId, loopName, childCount) {
  closeSessionCtxMenu();

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var renameItem = document.createElement("button");
  renameItem.className = "session-ctx-item";
  renameItem.innerHTML = iconHtml("pencil") + " <span>Rename</span>";
  renameItem.addEventListener("click", function (e) {
    e.stopPropagation();
    closeSessionCtxMenu();
    startLoopInlineRename(loopId, loopName);
  });
  menu.appendChild(renameItem);

  if (!store.get('permissions') || store.get('permissions').sessionDelete !== false) {
    var deleteItem = document.createElement("button");
    deleteItem.className = "session-ctx-item session-ctx-delete";
    deleteItem.innerHTML = iconHtml("trash-2") + " <span>Delete</span>";
    deleteItem.addEventListener("click", function (e) {
      e.stopPropagation();
      closeSessionCtxMenu();
      var msg = 'Delete "' + (loopName || "Loop") + '"';
      if (childCount > 1) msg += " and its " + childCount + " sessions";
      msg += "? This cannot be undone.";
      showConfirm(msg, function () {
        sendUserAction({ type: "delete_loop_group", loopId: loopId });
      });
    });
    menu.appendChild(deleteItem);
  }

  document.body.appendChild(menu);
  sessionCtxMenu = menu;
  refreshIcons();

  requestAnimationFrame(function () {
    var btnRect = anchorBtn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = (btnRect.bottom + 2) + "px";
    menu.style.right = (window.innerWidth - btnRect.right) + "px";
    menu.style.left = "auto";
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (btnRect.top - menuRect.height - 2) + "px";
    }
  });
}

function isSessionVisibleBySearch(sessionId) {
  if (searchMatchIds === null) return true;
  return searchMatchIds.has(sessionId);
}

// --- Loop child / run / group rendering ---

function renderLoopChild(s) {
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
      if (getWs() && store.get('connected')) {
        sendUserAction({ type: "switch_session", id: id });
        dismissOverlayPanels();
        closeSidebar();
      }
    };
  })(s.id));

  return el;
}

function renderLoopGroup(loopId, children, groupKey) {
  var visibleChildren = children;
  if (searchMatchIds !== null) {
    visibleChildren = [];
    for (var vi = 0; vi < children.length; vi++) {
      if (isSessionVisibleBySearch(children[vi].id)) {
        visibleChildren.push(children[vi]);
      }
    }
    if (visibleChildren.length === 0) {
      return null;
    }
  }

  var gk = groupKey || loopId;

  // Sub-group children by startedAt (each run)
  var runMap = {};
  for (var i = 0; i < visibleChildren.length; i++) {
    var runKey = String(visibleChildren[i].loop && visibleChildren[i].loop.startedAt || 0);
    if (!runMap[runKey]) runMap[runKey] = [];
    runMap[runKey].push(visibleChildren[i]);
  }
  var runKeys = Object.keys(runMap);

  // Sort each run's children by iteration then role
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

  // Sort runs by startedAt descending (newest first)
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

  // Group header row
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
      renderSessionList(null);
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

  // More button (ellipsis)
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

  // Click row (not chevron/more) -> switch to latest session
  el.addEventListener("click", (function (id) {
    return function () {
      if (getWs() && store.get('connected')) {
        sendUserAction({ type: "switch_session", id: id });
        dismissOverlayPanels();
        closeSidebar();
      }
    };
  })(latestSession.id));

  wrapper.appendChild(el);

  // Expanded: show runs as sub-groups
  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "session-loop-children";

    if (runCount === 1) {
      // Single run: show sessions directly (no extra nesting)
      var singleRun = runMap[runKeys[0]];
      for (var sk = 0; sk < singleRun.length; sk++) {
        childContainer.appendChild(renderLoopChild(singleRun[sk]));
      }
    } else {
      // Multiple runs: render each run as a collapsible sub-group
      for (var rk = 0; rk < runKeys.length; rk++) {
        childContainer.appendChild(renderLoopRun(gk, runKeys[rk], runMap[runKeys[rk]], isRalph));
      }
    }

    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

function renderLoopRun(parentGk, startedAtKey, sessions, isRalph) {
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
      renderSessionList(null);
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

  // Click row -> switch to latest session of this run
  el.addEventListener("click", (function (id) {
    return function () {
      if (getWs() && store.get('connected')) {
        sendUserAction({ type: "switch_session", id: id });
        dismissOverlayPanels();
        closeSidebar();
      }
    };
  })(latestSession.id));

  wrapper.appendChild(el);

  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "session-loop-children";
    for (var k = 0; k < sessions.length; k++) {
      childContainer.appendChild(renderLoopChild(sessions[k]));
    }
    wrapper.appendChild(childContainer);
  }

  return wrapper;
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
  stickyTop.appendChild(renderSessionTopActions());
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
      var loopEl = renderLoopGroup(item.loopId, item.children, item.groupKey);
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
