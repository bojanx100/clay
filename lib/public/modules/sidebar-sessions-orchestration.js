import { escapeHtml, showToast } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { sendUserAction } from './app-connection.js';

var picker = null;
var pendingSource = null;

function closePicker() {
  if (picker && picker.parentNode) picker.parentNode.removeChild(picker);
  picker = null;
  pendingSource = null;
}

function modalShell(source) {
  var overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.48);z-index:10020;display:flex;align-items:center;justify-content:center";
  var modal = document.createElement("div");
  modal.style.cssText = "background:var(--bg-alt);color:var(--text);border:1px solid var(--border);border-radius:12px;width:440px;max-width:92vw;max-height:76vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.3)";
  var header = document.createElement("div");
  header.style.cssText = "padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between";
  header.innerHTML = "<strong>Add to coordinator\u2026</strong>";
  var close = document.createElement("button");
  close.type = "button";
  close.innerHTML = iconHtml("x");
  close.setAttribute("aria-label", "Close");
  close.style.cssText = "background:none;border:0;color:var(--text);cursor:pointer;padding:4px";
  close.addEventListener("click", closePicker);
  header.appendChild(close);
  modal.appendChild(header);
  var intro = document.createElement("div");
  intro.style.cssText = "padding:12px 16px 8px;color:var(--text-dim);font-size:13px;line-height:1.45";
  intro.innerHTML = "Choose a coordinator to take <strong>" +
    escapeHtml(source.title || "New Session") +
    "</strong> as an owned worker. It will attach the conversation to a new or existing task and continue it.";
  modal.appendChild(intro);
  var body = document.createElement("div");
  body.className = "orchestration-coordinator-picker-body";
  body.style.cssText = "padding:8px;overflow:auto";
  body.textContent = "Finding coordinators\u2026";
  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closePicker();
  });
  return overlay;
}

export function openCoordinatorPicker(source) {
  closePicker();
  pendingSource = source;
  picker = modalShell(source);
  document.body.appendChild(picker);
  refreshIcons();
  sendUserAction({ type: "list_orchestration_coordinators", sourceSessionId: source.id });
}

export function handleCoordinatorCandidates(msg) {
  if (!picker || !pendingSource || msg.sourceSessionId !== pendingSource.id) return;
  var body = picker.querySelector(".orchestration-coordinator-picker-body");
  var candidates = Array.isArray(msg.candidates) ? msg.candidates : [];
  body.innerHTML = "";
  if (!candidates.length) {
    body.textContent = "No other eligible sessions are open.";
    return;
  }
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    var row = document.createElement("button");
    row.type = "button";
    row.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:none;color:var(--text);font:inherit;text-align:left;cursor:pointer";
    row.addEventListener("mouseover", function () { this.style.background = "var(--sidebar-hover)"; });
    row.addEventListener("mouseout", function () { this.style.background = "none"; });
    var icon = candidate.isCoordinator ? "git-branch" : "message-square";
    var meta = [];
    if (candidate.recommended) meta.push("Recommended");
    if (candidate.isCoordinator) meta.push("Coordinator");
    if (candidate.isProcessing) meta.push("Working");
    row.innerHTML = iconHtml(icon) + '<span style="min-width:0;flex:1"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
      escapeHtml(candidate.title || "New Session") + '</span><span style="display:block;color:var(--text-dim);font-size:11px">' +
      escapeHtml(meta.join(" \u00b7 ") || "Available session") + "</span></span>" + iconHtml("chevron-right");
    (function (target, button) {
      button.addEventListener("click", function () {
        button.disabled = true;
        sendUserAction({
          type: "propose_session_adoption",
          sourceSessionId: pendingSource.id,
          coordinatorSessionId: target.id,
          adoptionIntent: "worker",
        });
      });
    })(candidate, row);
    body.appendChild(row);
  }
  refreshIcons();
}

export function handleSessionAdoptionProposed(msg) {
  if (!pendingSource || msg.sourceSessionId !== pendingSource.id) return;
  if (msg.ok) {
    showToast("Offered to the coordinator. It will attach the session as a worker when ready.", "success");
    closePicker();
  } else {
    showToast("Could not offer this session to that coordinator.", "error");
    var buttons = picker ? picker.querySelectorAll("button") : [];
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
  }
}
