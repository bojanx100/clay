import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';

var ctx;
var deps = {};
var pendingElicitations = {};
var pendingUserDialogs = {};

export function initDialogTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

export function resetDialogTools() {
  pendingElicitations = {};
  pendingUserDialogs = {};
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

export function renderElicitationRequest(msg) {
  if (pendingElicitations[msg.requestId]) return;
  ctx.finalizeAssistantBlock();
  stopThinking();
  closeToolGroup();

  var container = document.createElement("div");
  container.className = "permission-container elicitation-container";
  container.dataset.requestId = msg.requestId;

  var header = document.createElement("div");
  header.className = "permission-header";
  header.innerHTML =
    '<span class="permission-icon">' + iconHtml("key") + '</span>' +
    '<span class="permission-title">' + escapeHtml(msg.serverName || "MCP Server") + ' requests input</span>';

  var body = document.createElement("div");
  body.className = "permission-body";

  if (msg.message) {
    var messageEl = document.createElement("div");
    messageEl.className = "permission-reason";
    messageEl.textContent = msg.message;
    body.appendChild(messageEl);
  }

  if (msg.mode === "url" && msg.url) {
    var urlInfo = document.createElement("div");
    urlInfo.className = "elicitation-url-info";
    urlInfo.style.cssText = "margin-top: 8px; font-size: 12px; color: var(--text-muted);";
    urlInfo.textContent = "Opens: " + msg.url;
    body.appendChild(urlInfo);
  } else if (msg.requestedSchema && msg.requestedSchema.properties) {
    renderElicitationForm(body, msg);
  }

  var actions = document.createElement("div");
  actions.className = "permission-actions";

  var acceptBtn = document.createElement("button");
  acceptBtn.className = "permission-btn permission-allow";

  if (msg.mode === "url" && msg.url) {
    acceptBtn.textContent = "Open & Approve";
    acceptBtn.addEventListener("click", function () {
      window.open(msg.url, "_blank");
      sendElicitationResponse(container, msg.requestId, "accept", {});
    });
  } else {
    acceptBtn.textContent = "Submit";
    acceptBtn.addEventListener("click", function () {
      sendElicitationResponse(container, msg.requestId, "accept", collectElicitationContent(container));
    });
  }

  var denyBtn = document.createElement("button");
  denyBtn.className = "permission-btn permission-deny";
  denyBtn.textContent = "Deny";
  denyBtn.addEventListener("click", function () {
    sendElicitationResponse(container, msg.requestId, "reject", null);
  });

  actions.appendChild(acceptBtn);
  actions.appendChild(denyBtn);

  container.appendChild(header);
  container.appendChild(body);
  container.appendChild(actions);
  ctx.addToMessages(container);

  pendingElicitations[msg.requestId] = container;
  refreshIcons();
  ctx.setActivity(null);
  maybeScrollToBottom();
}

function renderElicitationForm(body, msg) {
  var formEl = document.createElement("div");
  formEl.className = "elicitation-form";
  formEl.style.cssText = "margin-top: 8px; display: flex; flex-direction: column; gap: 8px;";

  var props = msg.requestedSchema.properties;
  var required = msg.requestedSchema.required || [];
  var propNames = Object.keys(props);
  for (var i = 0; i < propNames.length; i++) {
    var propName = propNames[i];
    var prop = props[propName];
    var isRequired = required.indexOf(propName) !== -1;

    var fieldWrapper = document.createElement("div");
    fieldWrapper.style.cssText = "display: flex; flex-direction: column; gap: 2px;";

    var label = document.createElement("label");
    label.style.cssText = "font-size: 12px; font-weight: 500; color: var(--text-secondary);";
    label.textContent = propName + (isRequired ? " *" : "");
    if (prop.description) {
      label.title = prop.description;
    }

    var input = createElicitationInput(prop, propName);
    fieldWrapper.appendChild(label);
    fieldWrapper.appendChild(input);
    formEl.appendChild(fieldWrapper);
  }
  body.appendChild(formEl);
}

function createElicitationInput(prop, propName) {
  var input;
  if (prop.type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.propName = propName;
    input.dataset.propType = "boolean";
  } else if (prop.enum) {
    input = document.createElement("select");
    input.dataset.propName = propName;
    input.dataset.propType = "enum";
    input.style.cssText = "padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text-primary); font-size: 13px;";
    for (var ei = 0; ei < prop.enum.length; ei++) {
      var opt = document.createElement("option");
      opt.value = prop.enum[ei];
      opt.textContent = prop.enum[ei];
      input.appendChild(opt);
    }
  } else {
    input = document.createElement("input");
    input.type = prop.type === "number" || prop.type === "integer" ? "number" : "text";
    input.dataset.propName = propName;
    input.dataset.propType = prop.type || "string";
    input.placeholder = prop.description || propName;
    input.style.cssText = "padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text-primary); font-size: 13px;";
  }
  return input;
}

function collectElicitationContent(container) {
  var content = {};
  var inputs = container.querySelectorAll("[data-prop-name]");
  for (var j = 0; j < inputs.length; j++) {
    var inp = inputs[j];
    var name = inp.dataset.propName;
    var pType = inp.dataset.propType;
    if (pType === "boolean") {
      content[name] = inp.checked;
    } else if (pType === "number" || pType === "integer") {
      content[name] = Number(inp.value);
    } else {
      content[name] = inp.value;
    }
  }
  return content;
}

function sendElicitationResponse(container, requestId, action, content) {
  if (container.classList.contains("resolved")) return;
  container.classList.add("resolved");
  if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();

  var label = action === "reject" ? "Denied" : "Submitted";
  var resolvedClass = action === "reject" ? "resolved-denied" : "resolved-allowed";
  container.classList.add(resolvedClass);

  var actions = container.querySelector(".permission-actions");
  if (actions) {
    actions.innerHTML = '<span class="permission-decision-label">' + label + '</span>';
  }

  if (ctx.ws && ctx.connected) {
    var msg = {
      type: "elicitation_response",
      requestId: requestId,
      action: action,
    };
    if (action === "accept" && content) {
      msg.content = content;
    }
    ctx.ws.send(JSON.stringify(msg));
  }

  delete pendingElicitations[requestId];
}

export function markElicitationResolved(requestId, action) {
  var container = pendingElicitations[requestId];
  if (!container) {
    container = ctx.messagesEl.querySelector('.elicitation-container[data-request-id="' + requestId + '"]');
  }
  if (!container || container.classList.contains("resolved")) return;

  container.classList.add("resolved");
  var isDeny = action === "reject";
  container.classList.add(isDeny ? "resolved-denied" : "resolved-allowed");

  var label = isDeny ? "Denied" : "Submitted";
  var actionsEl = container.querySelector(".permission-actions");
  if (actionsEl) {
    actionsEl.innerHTML = '<span class="permission-decision-label">' + label + '</span>';
  }
  delete pendingElicitations[requestId];
}

function sendUserDialogResponse(container, requestId, behavior, result) {
  if (container.classList.contains("resolved")) return;
  container.classList.add("resolved");
  if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();

  var isCancel = behavior !== "completed";
  container.classList.add(isCancel ? "resolved-denied" : "resolved-allowed");

  var actions = container.querySelector(".permission-actions");
  if (actions) {
    actions.innerHTML = '<span class="permission-decision-label">' + (isCancel ? "Cancelled" : "Submitted") + '</span>';
  }

  if (ctx.ws && ctx.connected) {
    var msg = {
      type: "user_dialog_response",
      requestId: requestId,
      behavior: isCancel ? "cancelled" : "completed",
    };
    if (!isCancel) msg.result = result;
    ctx.ws.send(JSON.stringify(msg));
  }

  delete pendingUserDialogs[requestId];
}

export function renderUserDialogRequest(msg) {
  if (pendingUserDialogs[msg.requestId]) return;
  ctx.finalizeAssistantBlock();
  stopThinking();
  closeToolGroup();

  var payload = msg.payload || {};
  try { console.log("[user_dialog] kind=" + msg.dialogKind + " payload=", payload); } catch (e) {}

  var container = document.createElement("div");
  container.className = "permission-container user-dialog-container";
  container.dataset.requestId = msg.requestId;

  var titleText = payload.title || "Claude needs a decision";
  var header = document.createElement("div");
  header.className = "permission-header";
  header.innerHTML =
    '<span class="permission-icon">' + iconHtml("key") + '</span>' +
    '<span class="permission-title">' + escapeHtml(titleText) + '</span>';

  var body = document.createElement("div");
  body.className = "permission-body";
  var messageText = payload.message || payload.prompt || payload.question || payload.text || "";
  if (messageText) {
    var messageEl = document.createElement("div");
    messageEl.className = "permission-reason";
    messageEl.textContent = String(messageText);
    body.appendChild(messageEl);
  }
  var kindEl = document.createElement("div");
  kindEl.className = "user-dialog-kind";
  kindEl.style.cssText = "margin-top: 6px; font-size: 11px; color: var(--text-muted);";
  kindEl.textContent = msg.dialogKind || "dialog";
  body.appendChild(kindEl);

  var actions = document.createElement("div");
  actions.className = "permission-actions";
  var choices = Array.isArray(payload.options) ? payload.options
    : Array.isArray(payload.choices) ? payload.choices
    : null;

  if (choices && choices.length) {
    renderUserDialogChoices(actions, container, msg, choices);
  } else {
    var proceedBtn = document.createElement("button");
    proceedBtn.className = "permission-btn permission-allow";
    proceedBtn.textContent = "Proceed";
    proceedBtn.addEventListener("click", function () {
      sendUserDialogResponse(container, msg.requestId, "completed", {});
    });
    actions.appendChild(proceedBtn);
  }

  var cancelBtn = document.createElement("button");
  cancelBtn.className = "permission-btn permission-deny";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", function () {
    sendUserDialogResponse(container, msg.requestId, "cancelled", null);
  });
  actions.appendChild(cancelBtn);

  container.appendChild(header);
  container.appendChild(body);
  container.appendChild(actions);
  ctx.addToMessages(container);

  pendingUserDialogs[msg.requestId] = container;
  refreshIcons();
  ctx.setActivity(null);
  maybeScrollToBottom();
}

function renderUserDialogChoices(actions, container, msg, choices) {
  for (var i = 0; i < choices.length; i++) {
    (function (choice) {
      var label = (choice && (choice.label || choice.title || choice.name)) || String(choice);
      var value = (choice && ("value" in choice)) ? choice.value : choice;
      var btn = document.createElement("button");
      btn.className = "permission-btn permission-allow";
      btn.textContent = label;
      btn.addEventListener("click", function () {
        sendUserDialogResponse(container, msg.requestId, "completed", value);
      });
      actions.appendChild(btn);
    })(choices[i]);
  }
}

export function markUserDialogResolved(requestId, behavior) {
  var container = pendingUserDialogs[requestId];
  if (!container) {
    container = ctx.messagesEl.querySelector('.user-dialog-container[data-request-id="' + requestId + '"]');
  }
  if (!container || container.classList.contains("resolved")) return;

  container.classList.add("resolved");
  var isCancel = behavior !== "completed";
  container.classList.add(isCancel ? "resolved-denied" : "resolved-allowed");

  var actionsEl = container.querySelector(".permission-actions");
  if (actionsEl) {
    actionsEl.innerHTML = '<span class="permission-decision-label">' + (isCancel ? "Cancelled" : "Submitted") + '</span>';
  }
  delete pendingUserDialogs[requestId];
}
