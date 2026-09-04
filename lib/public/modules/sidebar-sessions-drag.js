import { sendUserAction } from './app-connection.js';
import { getSessionListEl } from './dom-refs.js';

var draggedSessionId = null;
var draggedSessionBookmarked = false;

export function sendSessionBookmark(sessionId, bookmarked) {
  sendUserAction({ type: "set_session_bookmark", sessionId: sessionId, bookmarked: !!bookmarked });
}

function clearSessionDragIndicators() {
  var listEl = getSessionListEl();
  if (!listEl) return;
  var active = listEl.querySelectorAll(".session-favorites-divider.drag-hover, .session-regular-drop.drag-hover, .session-item.dragging");
  for (var i = 0; i < active.length; i++) {
    active[i].classList.remove("drag-hover", "dragging");
  }
}

export function setupSessionDragHandlers(el, session) {
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

export function setupBookmarkDropTarget(el, bookmarked) {
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
