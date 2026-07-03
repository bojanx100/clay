import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { mateAvatarUrl } from './avatar.js';
import { getChatLayout } from './theme.js';
import { VENDOR_NAMES } from './app-rendering.js';

var ctx;
var deps = {};
var pendingPermissions = {};

export function initPermissionTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

export function resetPermissionTools() {
  pendingPermissions = {};
}

function maybeScrollToBottom() {
  if (deps.maybeScrollToBottom) deps.maybeScrollToBottom();
}

function stopThinking() {
  if (deps.stopThinking) deps.stopThinking();
}

function closeToolGroup() {
  if (deps.closeToolGroup) deps.closeToolGroup();
}

function shortPath(p) {
  if (deps.shortPath) return deps.shortPath(p);
  if (!p) return "";
  var parts = p.split("/");
  return parts.length > 3 ? ".../" + parts.slice(-3).join("/") : p;
}

function toolSummary(name, input) {
  if (deps.toolSummary) return deps.toolSummary(name, input);
  if (!input || typeof input !== "object") return "";
  return JSON.stringify(input).substring(0, 60);
}

function getPlanContent() {
  return deps.getPlanContent ? deps.getPlanContent() : null;
}

function permissionInputSummary(toolName, input) {
  if (!input || typeof input !== "object") return "";
  switch (toolName) {
    case "Bash": return input.command || input.description || "";
    case "Edit": return shortPath(input.file_path);
    case "Write": return shortPath(input.file_path);
    case "Read": return shortPath(input.file_path);
    case "Glob": return input.pattern || "";
    case "Grep": return (input.pattern || "") + (input.path ? " in " + shortPath(input.path) : "");
    default: return toolSummary(toolName, input);
  }
}

export function renderPermissionRequest(requestId, toolName, toolInput, decisionReason, mateId, vendor) {
  if (pendingPermissions[requestId]) return;
  ctx.finalizeAssistantBlock();
  stopThinking();
  closeToolGroup();

  if (toolName === "ExitPlanMode") {
    renderPlanPermission(requestId);
    return;
  }

  if ((ctx.isMateDm && ctx.isMateDm()) || getChatLayout() === "channel") {
    renderConversationalPermission(requestId, toolName, toolInput, mateId, vendor);
    return;
  }

  renderFormalPermission(requestId, toolName, toolInput, decisionReason);
}

function renderFormalPermission(requestId, toolName, toolInput, decisionReason) {
  var container = document.createElement("div");
  container.className = "permission-container";
  container.dataset.requestId = requestId;

  var header = document.createElement("div");
  header.className = "permission-header";
  header.innerHTML =
    '<span class="permission-icon">' + iconHtml("shield") + '</span>' +
    '<span class="permission-title">Permission Required</span>';

  var body = document.createElement("div");
  body.className = "permission-body";

  var summary = document.createElement("div");
  summary.className = "permission-summary";
  var summaryText = permissionInputSummary(toolName, toolInput);
  summary.innerHTML =
    '<span class="permission-tool-name"></span>' +
    (summaryText ? '<span class="permission-tool-desc"></span>' : '');
  summary.querySelector(".permission-tool-name").textContent = toolName;
  if (summaryText) {
    summary.querySelector(".permission-tool-desc").textContent = summaryText;
  }
  body.appendChild(summary);

  if (decisionReason) {
    var reason = document.createElement("div");
    reason.className = "permission-reason";
    reason.textContent = decisionReason;
    body.appendChild(reason);
  }

  var details = document.createElement("details");
  details.className = "permission-details";
  var detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "Details";
  var detailsPre = document.createElement("pre");
  detailsPre.textContent = JSON.stringify(toolInput, null, 2);
  details.appendChild(detailsSummary);
  details.appendChild(detailsPre);
  body.appendChild(details);

  var actions = document.createElement("div");
  actions.className = "permission-actions";

  var allowBtn = document.createElement("button");
  allowBtn.className = "permission-btn permission-allow";
  allowBtn.textContent = "Allow Once";
  allowBtn.addEventListener("click", function () {
    sendPermissionResponse(container, requestId, "allow");
  });

  var allowAlwaysBtn = document.createElement("button");
  allowAlwaysBtn.className = "permission-btn permission-allow-session";
  allowAlwaysBtn.textContent = "Allow for Session";
  allowAlwaysBtn.addEventListener("click", function () {
    sendPermissionResponse(container, requestId, "allow_always");
  });

  var denyBtn = document.createElement("button");
  denyBtn.className = "permission-btn permission-deny";
  denyBtn.textContent = "Deny";
  denyBtn.addEventListener("click", function () {
    sendPermissionResponse(container, requestId, "deny");
  });

  actions.appendChild(allowBtn);
  actions.appendChild(allowAlwaysBtn);
  actions.appendChild(denyBtn);

  container.appendChild(header);
  container.appendChild(body);
  container.appendChild(actions);
  ctx.addToMessages(container);

  pendingPermissions[requestId] = container;
  refreshIcons();
  ctx.setActivity(null);
  maybeScrollToBottom();
}

function renderPlanPermission(requestId) {
  if (pendingPermissions[requestId]) return;
  var container = document.createElement("div");
  container.className = "permission-container plan-permission";
  container.dataset.requestId = requestId;

  var header = document.createElement("div");
  header.className = "permission-header plan-permission-header";
  header.innerHTML =
    '<span class="permission-icon">' + iconHtml("check-circle") + '</span>' +
    '<span class="permission-title">Plan Approval</span>';

  var body = document.createElement("div");
  body.className = "permission-body";

  var actions = document.createElement("div");
  actions.className = "permission-actions plan-permission-actions";

  var clearBtn = document.createElement("button");
  clearBtn.className = "permission-btn plan-btn-clear";
  var contextPct = ctx.getContextPercent ? ctx.getContextPercent() : 0;
  clearBtn.innerHTML = iconHtml("refresh-cw") + ' <span>Clear context' +
    (contextPct > 0 ? ' <span class="plan-ctx-pct">(' + contextPct + '% used)</span>' : '') +
    ' &amp; auto-accept</span>';
  clearBtn.addEventListener("click", function () {
    sendPlanResponse(container, requestId, "allow_clear_context");
  });

  var approveBtn = document.createElement("button");
  approveBtn.className = "permission-btn permission-allow";
  approveBtn.textContent = "Auto-accept edits";
  approveBtn.addEventListener("click", function () {
    sendPlanResponse(container, requestId, "allow_accept_edits");
  });

  var manualBtn = document.createElement("button");
  manualBtn.className = "permission-btn permission-allow-session";
  manualBtn.textContent = "Manually approve";
  manualBtn.addEventListener("click", function () {
    sendPlanResponse(container, requestId, "allow");
  });

  var rejectBtn = document.createElement("button");
  rejectBtn.className = "permission-btn permission-deny";
  rejectBtn.textContent = "Reject";
  rejectBtn.addEventListener("click", function () {
    sendPlanResponse(container, requestId, "deny");
  });

  actions.appendChild(clearBtn);
  actions.appendChild(approveBtn);
  actions.appendChild(manualBtn);
  actions.appendChild(rejectBtn);

  var feedbackRow = document.createElement("div");
  feedbackRow.className = "plan-feedback-row";
  var feedbackInput = document.createElement("input");
  feedbackInput.type = "text";
  feedbackInput.className = "plan-feedback-input";
  feedbackInput.placeholder = "Tell Claude what to change...";
  var feedbackSendBtn = document.createElement("button");
  feedbackSendBtn.className = "plan-feedback-send";
  feedbackSendBtn.innerHTML = iconHtml("arrow-up");
  feedbackSendBtn.disabled = true;

  feedbackInput.addEventListener("input", function () {
    feedbackSendBtn.disabled = !feedbackInput.value.trim();
  });
  feedbackInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && feedbackInput.value.trim()) {
      e.preventDefault();
      submitPlanFeedback();
    }
  });
  feedbackSendBtn.addEventListener("click", function () {
    if (feedbackInput.value.trim()) submitPlanFeedback();
  });

  function submitPlanFeedback() {
    var text = feedbackInput.value.trim();
    if (!text) return;
    sendPlanResponse(container, requestId, "deny_with_feedback", text);
  }

  feedbackRow.appendChild(feedbackInput);
  feedbackRow.appendChild(feedbackSendBtn);

  container.appendChild(header);
  container.appendChild(body);
  container.appendChild(actions);
  container.appendChild(feedbackRow);
  ctx.addToMessages(container);

  pendingPermissions[requestId] = container;
  refreshIcons();
  ctx.setActivity(null);
  maybeScrollToBottom();
  setTimeout(function () { feedbackInput.focus(); }, 50);
}

function sendPlanResponse(container, requestId, decision, feedback) {
  if (container.classList.contains("resolved")) return;
  container.classList.add("resolved");
  if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();

  var labelMap = {
    "allow": "Approved (manual)",
    "allow_accept_edits": "Approved (auto-accept)",
    "allow_clear_context": "Approved (clear + auto-accept)",
    "deny": "Rejected",
    "deny_with_feedback": "Feedback sent",
  };
  var label = labelMap[decision] || decision;
  var isDeny = decision === "deny" || decision === "deny_with_feedback";
  var resolvedClass = isDeny ? "resolved-denied" : "resolved-allowed";
  container.classList.add(resolvedClass);

  var actionsEl = container.querySelector(".plan-permission-actions");
  if (actionsEl) {
    actionsEl.innerHTML = '<span class="permission-decision-label">' + label + '</span>';
  }
  var feedbackRowEl = container.querySelector(".plan-feedback-row");
  if (feedbackRowEl) feedbackRowEl.remove();

  if (ctx.ws && ctx.connected) {
    var payload = {
      type: "permission_response",
      requestId: requestId,
      decision: decision,
    };
    if (feedback) payload.feedback = feedback;
    if (decision === "allow_clear_context" && getPlanContent()) {
      payload.planContent = getPlanContent();
    }
    ctx.ws.send(JSON.stringify(payload));
  }

  delete pendingPermissions[requestId];
}

function matePermissionInfo(toolName, toolInput) {
  var input = toolInput && typeof toolInput === "object" ? toolInput : {};
  var verb = "use " + toolName;
  var target = "";

  switch (toolName) {
    case "Write": verb = "write to"; target = shortPath(input.file_path); break;
    case "Edit": verb = "edit"; target = shortPath(input.file_path); break;
    case "Read": verb = "read"; target = shortPath(input.file_path); break;
    case "Bash": verb = "run"; target = input.description || (input.command || "").substring(0, 80); break;
    case "Grep": verb = "search"; target = input.pattern || ""; break;
    case "Glob": verb = "search for files in"; target = input.pattern || ""; break;
    case "WebFetch": verb = "fetch"; target = input.url || ""; break;
    case "WebSearch": verb = "search the web for"; target = input.query || ""; break;
  }
  return { verb: verb, target: target };
}

function resolvePermissionIdentity(mateId, vendor) {
  if (ctx.isMateDm && ctx.isMateDm()) {
    var name = ctx.getMateName();
    var avatar = ctx.getMateAvatarUrl();
    if (mateId && ctx.getMateById) {
      var mentionMate = ctx.getMateById(mateId);
      if (mentionMate) {
        name = (mentionMate.profile && mentionMate.profile.displayName) || mentionMate.displayName || mentionMate.name || name;
        avatar = mateAvatarUrl(mentionMate, 36);
      }
    }
    return { name: name, avatar: avatar };
  }
  if (mateId && ctx.getMateById) {
    var mate = ctx.getMateById(mateId);
    if (mate) {
      return {
        name: (mate.profile && mate.profile.displayName) || mate.displayName || mate.name || "Mate",
        avatar: mateAvatarUrl(mate, 36)
      };
    }
  }
  var vendorAvatars = { claude: "/claude-code-avatar.png", codex: "/codex-avatar.png" };
  var vendorName = (vendor && VENDOR_NAMES[vendor]) || VENDOR_NAMES.claude;
  return {
    name: vendorName,
    avatar: (vendor && vendorAvatars[vendor]) || vendorAvatars.claude,
  };
}

function renderConversationalPermission(requestId, toolName, toolInput, mateId, vendor) {
  var identity = resolvePermissionIdentity(mateId, vendor);
  var info = matePermissionInfo(toolName, toolInput);
  var askMsg = "Can I " + info.verb + (info.target ? " " + info.target : "") + "?";

  var container = document.createElement("div");
  container.className = "permission-container mate-permission";
  container.dataset.requestId = requestId;

  var avi = document.createElement("img");
  avi.className = "dm-bubble-avatar dm-bubble-avatar-mate";
  avi.src = identity.avatar;
  avi.alt = "";
  container.appendChild(avi);

  var content = document.createElement("div");
  content.className = "dm-bubble-content";

  var headerRow = document.createElement("div");
  headerRow.className = "dm-bubble-header";
  headerRow.innerHTML =
    '<span class="dm-bubble-name">' + escapeHtml(identity.name) + '</span>' +
    '<span class="dm-bubble-time">' + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + '</span>';
  content.appendChild(headerRow);

  var askEl = document.createElement("div");
  askEl.className = "mate-perm-ask";
  askEl.textContent = askMsg;
  content.appendChild(askEl);

  var details = document.createElement("details");
  details.className = "mate-perm-details";
  var summary = document.createElement("summary");
  summary.textContent = "Details";
  var pre = document.createElement("pre");
  pre.textContent = JSON.stringify(toolInput, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  content.appendChild(details);

  var actions = document.createElement("div");
  actions.className = "permission-actions mate-permission-actions";

  var allowBtn = document.createElement("button");
  allowBtn.className = "mate-permission-reply mate-permission-allow";
  allowBtn.textContent = "Sure";
  allowBtn.addEventListener("click", function () {
    sendPermissionResponse(container, requestId, "allow");
  });

  var alwaysBtn = document.createElement("button");
  alwaysBtn.className = "mate-permission-reply mate-permission-always";
  alwaysBtn.textContent = "Allow for session";
  alwaysBtn.addEventListener("click", function () {
    sendPermissionResponse(container, requestId, "allow_always");
  });

  var denyBtn = document.createElement("button");
  denyBtn.className = "mate-permission-reply mate-permission-deny";
  denyBtn.textContent = "No";
  denyBtn.addEventListener("click", function () {
    sendPermissionResponse(container, requestId, "deny");
  });

  actions.appendChild(allowBtn);
  actions.appendChild(alwaysBtn);
  actions.appendChild(denyBtn);
  content.appendChild(actions);

  container.appendChild(content);

  ctx.addToMessages(container);
  pendingPermissions[requestId] = container;
  refreshIcons();
  ctx.setActivity(null);
  maybeScrollToBottom();
}

function sendPermissionResponse(container, requestId, decision) {
  if (container.classList.contains("resolved")) return;
  container.classList.add("resolved");
  if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();

  var label = decision === "deny" ? "Denied" : decision === "allow_always" ? "Allowed for session" : "Allowed";
  var resolvedClass = decision === "deny" ? "resolved-denied" : "resolved-allowed";
  container.classList.add(resolvedClass);

  var actions = container.querySelector(".permission-actions");
  if (actions) {
    actions.innerHTML = '<span class="permission-decision-label">' + label + '</span>';
  }

  if (ctx.ws && ctx.connected) {
    ctx.ws.send(JSON.stringify({
      type: "permission_response",
      requestId: requestId,
      decision: decision,
    }));
  }

  delete pendingPermissions[requestId];
}

export function markPermissionResolved(requestId, decision) {
  var container = pendingPermissions[requestId];
  if (!container) {
    container = ctx.messagesEl.querySelector('[data-request-id="' + requestId + '"]');
  }
  if (!container || container.classList.contains("resolved")) return;

  container.classList.add("resolved");

  var planLabelMap = {
    "allow_accept_edits": "Approved (auto-accept)",
    "allow_clear_context": "Approved (clear + auto-accept)",
    "deny_with_feedback": "Feedback sent",
  };
  var isDeny = decision === "deny" || decision === "deny_with_feedback";
  var resolvedClass = isDeny ? "resolved-denied" : "resolved-allowed";
  container.classList.add(resolvedClass);

  var label = planLabelMap[decision] || (decision === "deny" ? "Denied" : decision === "allow_always" ? "Allowed for session" : "Allowed");
  var actions = container.querySelector(".permission-actions") || container.querySelector(".plan-permission-actions");
  if (actions) {
    actions.innerHTML = '<span class="permission-decision-label">' + label + '</span>';
  }
  var feedbackRow = container.querySelector(".plan-feedback-row");
  if (feedbackRow) feedbackRow.remove();

  delete pendingPermissions[requestId];
}

export function markPermissionCancelled(requestId) {
  var container = pendingPermissions[requestId];
  if (!container) {
    container = ctx.messagesEl.querySelector('[data-request-id="' + requestId + '"]');
  }
  if (!container || container.classList.contains("resolved")) return;

  container.classList.add("resolved", "resolved-cancelled");
  var actions = container.querySelector(".permission-actions");
  if (actions) {
    actions.innerHTML = '<span class="permission-decision-label">Cancelled</span>';
  }

  delete pendingPermissions[requestId];
}
