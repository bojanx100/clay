import { sendUserAction } from './app-connection.js';
import { getSessionListEl } from './dom-refs.js';

export function startInlineRename(sessionId, currentTitle) {
  var el = getSessionListEl().querySelector('.session-item[data-session-id="' + sessionId + '"]');
  if (!el) return;
  var textSpan = el.querySelector(".session-item-text");
  if (!textSpan) return;

  var input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.value = currentTitle || "New Session";

  var originalHtml = textSpan.innerHTML;
  textSpan.innerHTML = "";
  textSpan.appendChild(input);
  input.focus();
  input.select();

  function commitRename() {
    var newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      sendUserAction({ type: "rename_session", id: sessionId, title: newTitle });
    }
    textSpan.innerHTML = originalHtml;
    if (newTitle && newTitle !== currentTitle) {
      textSpan.textContent = newTitle;
    }
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { e.preventDefault(); textSpan.innerHTML = originalHtml; }
  });
  input.addEventListener("blur", commitRename);
  input.addEventListener("click", function (e) { e.stopPropagation(); });
}

export function startLoopInlineRename(loopId, currentName) {
  var el = getSessionListEl().querySelector('.session-loop-group[data-loop-id="' + loopId + '"]');
  if (!el) return;
  var textSpan = el.querySelector(".session-item-text");
  if (!textSpan) return;

  var input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.value = currentName || "Loop";

  var originalHtml = textSpan.innerHTML;
  textSpan.innerHTML = "";
  textSpan.appendChild(input);
  input.focus();
  input.select();

  function commitRename() {
    var newName = input.value.trim();
    if (newName && newName !== currentName) {
      sendUserAction({ type: "loop_registry_rename", id: loopId, name: newName });
    }
    textSpan.innerHTML = originalHtml;
    if (newName && newName !== currentName) {
      var nameNode = textSpan.querySelector(".session-loop-name");
      if (nameNode) nameNode.textContent = newName;
    }
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    if (e.key === "Escape") { e.preventDefault(); textSpan.innerHTML = originalHtml; }
  });
  input.addEventListener("blur", commitRename);
  input.addEventListener("click", function (e) { e.stopPropagation(); });
}
