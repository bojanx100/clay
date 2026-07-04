import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { showConfirm } from './app-misc.js';

function confirmDeleteSessionGroup(groupLabel, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return;
  var count = sessionIds.length;
  var noun = count === 1 ? "session" : "sessions";
  showConfirm('Clear "' + groupLabel + '"? ' + count + " " + noun + ' will be permanently removed.', function () {
    sendUserAction({ type: "bulk_delete_sessions", sessionIds: sessionIds });
  });
}

export function createSessionGroupHeader(group, sessionIds) {
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
