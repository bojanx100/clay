import { escapeHtml } from './utils.js';
import { iconHtml } from './icons.js';
import { sendUserAction } from './app-connection.js';

var movePickerEl = null;

function closeMoveProjectPicker() {
  if (movePickerEl && movePickerEl.parentNode) movePickerEl.parentNode.removeChild(movePickerEl);
  movePickerEl = null;
}

export function openMoveProjectPicker(sessionId, sessionTitle, projects) {
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
