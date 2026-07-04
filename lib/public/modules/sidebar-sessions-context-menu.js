import { escapeHtml, showToast } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { showConfirm } from './app-misc.js';
import { getCachedProjects } from './app-projects.js';
import { sendSessionBookmark } from './sidebar-sessions-drag.js';
import { startInlineRename, startLoopInlineRename } from './sidebar-sessions-rename.js';
import { openMoveProjectPicker } from './sidebar-sessions-move.js';
import { confirmDeleteSession } from './sidebar-sessions-delete.js';

var sessionCtxMenu = null;
var sessionCtxSessionId = null;

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

export function closeSessionCtxMenu() {
  if (sessionCtxMenu) {
    sessionCtxMenu.remove();
    sessionCtxMenu = null;
    sessionCtxSessionId = null;
  }
}

export function hasSessionCtxMenu() {
  return !!sessionCtxMenu;
}

export function setSessionCtxMenu(menu) {
  sessionCtxMenu = menu;
}

function positionMenu(anchorBtn, menu) {
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

export function showSessionCtxMenu(anchorBtn, sessionId, title, cliSid, sessionData) {
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
  positionMenu(anchorBtn, menu);
}

export function openSessionActionMenu(anchorBtn, sessionData) {
  if (!sessionData) return;
  showSessionCtxMenu(anchorBtn, sessionData.id, sessionData.title, sessionData.cliSessionId, sessionData);
}

export function showLoopCtxMenu(anchorBtn, loopId, loopName, childCount) {
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
  positionMenu(anchorBtn, menu);
}
