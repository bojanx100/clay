// Two-pane iframe shell for the split-view spike.

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { getCachedSessions } from './sidebar-sessions.js';
import { iconHtml, refreshIcons } from './icons.js';
import { detachTuiView } from './session-tui-view.js';

var host = null;
var nativeApp = null;
var dropOverlay = null;
var draggedSessionId = null;

function sessionById(sessionId) {
  var sessions = getCachedSessions() || [];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].id === sessionId) return sessions[i];
  }
  return null;
}

function paneForSession(sessionId) {
  var session = sessionById(sessionId);
  return {
    slug: store.get('currentSlug'),
    sessionId: sessionId,
    title: (session && session.title) || ("Session " + sessionId),
  };
}

function paneUrl(pane) {
  return "/p/" + encodeURIComponent(pane.slug) + "/?pane=1&session=" + encodeURIComponent(pane.sessionId);
}

function hideDropOverlay() {
  if (dropOverlay) dropOverlay.classList.remove("visible");
  draggedSessionId = null;
}

function showDropOverlay() {
  if (!dropOverlay || store.get('splitPanes')) return;
  dropOverlay.classList.add("visible");
}

function switchNativeSession(sessionId) {
  store.set({ splitPanes: null });
  var ws = getWs();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "switch_session", id: sessionId }));
  }
}

function closePane(index) {
  var panes = store.get('splitPanes');
  if (!panes || panes.length !== 2) return;
  switchNativeSession(panes[index === 0 ? 1 : 0].sessionId);
}

function createPane(pane, index) {
  var paneEl = document.createElement("section");
  paneEl.className = "split-pane";

  var header = document.createElement("header");
  header.className = "split-pane-header";
  var title = document.createElement("span");
  title.className = "split-pane-title";
  title.textContent = pane.title;
  header.appendChild(title);

  var close = document.createElement("button");
  close.type = "button";
  close.className = "split-pane-close";
  close.title = "Close pane";
  close.setAttribute("aria-label", "Close pane");
  close.innerHTML = iconHtml("x");
  close.addEventListener("click", function () { closePane(index); });
  header.appendChild(close);
  paneEl.appendChild(header);

  var frame = document.createElement("iframe");
  frame.className = "split-pane-frame";
  frame.src = paneUrl(pane);
  frame.title = pane.title;
  paneEl.appendChild(frame);
  return paneEl;
}

function renderSplit(panes) {
  if (!host || !nativeApp) return;
  host.innerHTML = "";
  if (!panes || panes.length !== 2) {
    host.classList.remove("visible");
    nativeApp.classList.remove("split-native-hidden");
    return;
  }
  nativeApp.classList.add("split-native-hidden");
  host.classList.add("visible");
  for (var i = 0; i < panes.length; i++) host.appendChild(createPane(panes[i], i));
  refreshIcons();
}

function openSplit(side, draggedId) {
  var currentId = store.get('activeSessionId');
  if (!currentId || !draggedId || currentId === draggedId || store.get('splitPanes')) {
    hideDropOverlay();
    return;
  }
  var current = paneForSession(currentId);
  var dragged = paneForSession(draggedId);
  var panes = side === "left" ? [dragged, current] : [current, dragged];
  hideDropOverlay();
  // The TUI host is position:fixed on document.body, so hiding #app does not
  // hide it. Detach before showing panes; exiting the split re-attaches via
  // the switch_session -> session_switched path.
  detachTuiView();
  store.set({ splitPanes: panes });
}

function createDropOverlay(mainPanels) {
  var overlay = document.createElement("div");
  overlay.className = "split-drop-overlay";
  var sides = ["left", "right"];
  for (var i = 0; i < sides.length; i++) {
    (function (side) {
      var zone = document.createElement("div");
      zone.className = "split-drop-zone split-drop-" + side;
      zone.dataset.side = side;
      zone.textContent = "Open " + side;
      zone.addEventListener("dragover", function (event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        zone.classList.add("active");
      });
      zone.addEventListener("dragleave", function () { zone.classList.remove("active"); });
      zone.addEventListener("drop", function (event) {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove("active");
        var droppedId = draggedSessionId || parseInt(event.dataTransfer.getData("text/plain"), 10);
        openSplit(side, droppedId);
      });
      overlay.appendChild(zone);
    })(sides[i]);
  }
  mainPanels.appendChild(overlay);
  return overlay;
}

function handleSessionDragStart(event) {
  if (store.get('splitPanes')) return;
  var item = event.target.closest("[data-session-id][draggable='true']");
  if (!item) return;
  draggedSessionId = parseInt(item.dataset.sessionId, 10);
  if (draggedSessionId) showDropOverlay();
}

function handleSidebarSessionClick(event) {
  if (!store.get('splitPanes') || event.button !== 0) return;
  if (event.target.closest(".session-close-btn, .session-more-btn")) return;
  var item = event.target.closest(".session-item[data-session-id], .session-loop-child[data-session-id]");
  if (!item) return;
  var sessionId = parseInt(item.dataset.sessionId, 10);
  if (!sessionId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  switchNativeSession(sessionId);
}

export function initSplitView() {
  if (store.get('paneMode')) return;
  var mainPanels = document.getElementById("main-panels");
  nativeApp = document.getElementById("app");
  if (!mainPanels || !nativeApp) return;

  host = document.createElement("div");
  host.id = "split-host";
  mainPanels.insertBefore(host, nativeApp.nextSibling);
  dropOverlay = createDropOverlay(mainPanels);

  document.addEventListener("dragstart", handleSessionDragStart);
  document.addEventListener("dragend", hideDropOverlay);
  document.addEventListener("drop", function (event) {
    if (dropOverlay && !dropOverlay.contains(event.target)) hideDropOverlay();
  });
  document.addEventListener("click", handleSidebarSessionClick, true);
  store.subscribe(function (state, prev) {
    if (state.splitPanes !== prev.splitPanes) renderSplit(state.splitPanes);
  });
  renderSplit(store.get('splitPanes'));
}
