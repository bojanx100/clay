import { store } from './store.js';
import { sendWsJson } from './ws-ref.js';
import { showConfirm } from './confirm-modal.js';

export function renderCoordinatorUpdateNotice(host, state) {
  var attention = state && state.coordinatorUpdates && state.coordinatorUpdates.attention || [];
  if (!attention.length) return;
  var notice = document.createElement("div");
  notice.className = "orchestration-reconciliation-stalled";
  var details = document.createElement("details");
  var title = document.createElement("summary");
  var uncertain = attention.some(function (entry) { return entry.uncertain; });
  title.textContent = uncertain ? "Report delivery needs review" : "Reports could not reach the coordinator";
  details.appendChild(title);
  var explanation = document.createElement("p");
  explanation.textContent = uncertain ? "The provider may have received these reports. Review the conversation before resending." :
    "Automatic delivery stopped after three failed starts. Fix the provider connection, then retry.";
  details.appendChild(explanation);
  attention.forEach(function (entry) {
    var report = document.createElement("pre");
    report.textContent = entry.text;
    report.style.whiteSpace = "pre-wrap";
    details.appendChild(report);
  });
  notice.appendChild(details);
  ["retry", "acknowledge"].forEach(function (action) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "orchestration-reconciliation-retry";
    button.textContent = action === "retry" ? "Retry reports" : "Mark reviewed";
    button.addEventListener("click", function () {
      // Capture the exact session and report set before a confirmation opens.
      var message = { type: "resolve_coordinator_updates", action: action,
        sessionId: store.get("activeSessionId"), preserveActiveSession: true, updateIds: attention.map(function (entry) { return entry.updateId; }) };
      var text = action === "retry" ? "Resend these reports? The coordinator may already have acted on them." :
        "Mark these reports as reviewed? They will leave the delivery queue and stay in the saved history.";
      showConfirm(text, function () { sendWsJson(message); }, button.textContent, false);
    });
    notice.appendChild(button);
  });
  host.appendChild(notice);
}
