import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { getSessionListEl } from './dom-refs.js';
import { spawnDustParticles } from './sidebar.js';
import { showConfirm } from './confirm-modal.js';

var armedDeleteSessionId = null;
var armedDeleteTimer = null;

function spawnSessionDeleteParticles(sessionId) {
  if (!spawnDustParticles) return;
  setTimeout(function () {
    var el = getSessionListEl().querySelector('[data-session-id="' + sessionId + '"]');
    if (!el) return;
    var rect = el.getBoundingClientRect();
    spawnDustParticles(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, 0);
}

export function confirmDeleteSession(session) {
  if (session && (session.coopHome || session.coopChannel)) return;
  showConfirm('Delete "' + (session.title || "New Session") + '"? This session and its history will be permanently removed.', function () {
    if (sendUserAction({ type: "delete_session", id: session.id })) {
      spawnSessionDeleteParticles(session.id);
    }
  });
}

export function clearArmedSessionDelete() {
  if (armedDeleteTimer) {
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = null;
  }
  if (armedDeleteSessionId !== null) {
    var listEl = getSessionListEl();
    var prevBtn = listEl ? listEl.querySelector('.session-close-btn[data-session-id="' + armedDeleteSessionId + '"]') : null;
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

export function appendSessionCloseButton(el, session) {
  if (store.get('permissions') && store.get('permissions').sessionDelete === false) return;
  if (session.coopHome || session.coopChannel) return;

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
    if (session.coordinationMode && session.orchestrationActiveCount > 0) {
      showConfirm(
        'Close "' + (session.title || "Coordinator") + '"? This will stop ' +
          session.orchestrationActiveCount + " active worker" +
          (session.orchestrationActiveCount === 1 ? "" : "s") +
          " and archive every worker conversation. Unintegrated results may be lost.",
        function () {
          if (sendUserAction({
            type: "hide_session",
            id: session.id,
            closeWorkers: true,
          })) {
            spawnSessionDeleteParticles(session.id);
          }
        },
        "Close coordinator and workers",
        true
      );
      return;
    }
    if (armedDeleteSessionId === session.id) {
      clearArmedSessionDelete();
      deleteSessionImmediately(session);
      return;
    }
    armSessionDelete(closeBtn, session);
  });
  el.appendChild(closeBtn);
}
