var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var approvalStaging = require("../lib/coop-approval-question-staging");
var itemApproval = require("../lib/coop-item-approval");

function element(tag) {
  var node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    className: "",
    disabled: false,
    _innerHTML: "",
    _text: "",
  };
  Object.defineProperty(node, "innerHTML", {
    get: function () { return node._innerHTML; },
    set: function (value) {
      node._innerHTML = String(value);
      node.children = [];
    },
  });
  Object.defineProperty(node, "textContent", {
    get: function () {
      if (!node.children.length) return node._text;
      return node.children.map(function (child) { return child.textContent; }).join("");
    },
    set: function (value) {
      node._text = String(value);
      node.children = [];
    },
  });
  node.classList = {
    add: function (name) {
      if (!node.classList.contains(name)) node.className = (node.className + " " + name).trim();
    },
    contains: function (name) {
      return node.className.split(/\s+/).indexOf(name) !== -1;
    },
  };
  node.setAttribute = function (name, value) { node.attributes[name] = String(value); };
  node.appendChild = function (child) { node.children.push(child); return child; };
  node.addEventListener = function (type, handler) {
    node.listeners[type] = (node.listeners[type] || []).concat(handler);
  };
  node.click = function () {
    var handlers = node.listeners.click || [];
    var event = { preventDefault: function () {}, stopPropagation: function () {} };
    for (var i = 0; i < handlers.length; i++) handlers[i](event);
  };
  return node;
}

function byClass(node, name) {
  var found = [];
  for (var i = 0; i < node.children.length; i++) {
    if (node.children[i].classList.contains(name)) found.push(node.children[i]);
    found = found.concat(byClass(node.children[i], name));
  }
  return found;
}

test("worker preview defaults to one compact expandable row", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/orchestration-task-preview.js"),
    "utf8"
  );
  var css = fs.readFileSync(
    path.join(__dirname, "../lib/public/css/input.css"),
    "utf8"
  );
  var sidebarSource = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/sidebar-sessions.js"),
    "utf8"
  );
  var sidebarCss = fs.readFileSync(
    path.join(__dirname, "../lib/public/css/sidebar.css"),
    "utf8"
  );
  var orchestratorSource = fs.readFileSync(
    path.join(__dirname, "../lib/project-task-orchestrator.js"),
    "utf8"
  );
  var runtimeSource = fs.readFileSync(
    path.join(__dirname, "../lib/project-runtime.js"),
    "utf8"
  );

  assert.match(source, /var MAX_PREVIEW_WORKERS = 3/);
  assert.match(source, /summary\.setAttribute\("aria-expanded", isExpanded \? "true" : "false"\)/);
  assert.match(source, /store\.set\(\{ orchestrationTaskPreviewExpanded: !isExpanded \}\)/);
  assert.match(source, /if \(!store\.get\("orchestrationTaskPreviewExpanded"\)\) \{/);
  assert.match(source, /state\.phase === "complete"/);
  assert.match(source, /Reconciliation stalled/);
  assert.match(source, /retry_orchestration_reconciliation/);
  assert.match(css, /\.orchestration-task-summary\s*\{[^}]*min-height:\s*42px[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(240px,\s*30dvh\)[^}]*overflow-y:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(168px,\s*22dvh\)/);
  assert.match(sidebarSource, /worker-status-" \+ orchestrationParent\.taskStatus/);
  assert.match(sidebarCss, /\.session-vendor-dot\.worker-status-completed\s*\{[^}]*background:\s*var\(--success\)/s);
  assert.match(sidebarCss, /\.session-item\.worker-status-completed\s*\{[^}]*--worker-state-color:\s*var\(--success\)/s);
  assert.match(sidebarCss, /box-shadow:[^;]*var\(--worker-state-color,\s*var\(--worker-color/s);
  assert.match(orchestratorSource, /if \(statusChanged\) sm\.broadcastSessionList\(\)/);
  assert.match(runtimeSource, /taskOrchestrator\.handleCoordinatorTurnDone\(session\)/);
  assert.match(css, /\.orchestration-task-status-waiting_user/);
  assert.match(css, /\.orchestration-task-status-dismissed/);
});

test("chat worker preview keeps unfinished work and hides resolved-only groups", async function () {
  var modulePath = path.join(
    __dirname, "../lib/public/modules/orchestration-task-preview.js"
  );
  var preview = await import(pathToFileURL(modulePath).href);
  var activeTasks = preview.activeWorkerPreviewTasks([
    { taskId: "queued", status: "queued" },
    { taskId: "running", status: "running" },
    { taskId: "attention", status: "needs_input" },
    { taskId: "completed", status: "completed" },
    { taskId: "dismissed", status: "dismissed" },
    { taskId: "cancelled", status: "cancelled" },
  ]);

  assert.deepEqual(activeTasks.map(function (task) { return task.taskId; }), [
    "queued", "running", "attention",
  ]);

  var host = { innerHTML: "stale preview" };
  var rendered = preview.renderOrchestrationTaskPreview(host, [
    { taskId: "completed", status: "completed" },
    { taskId: "dismissed", status: "dismissed" },
  ], { phase: "complete" });

  assert.equal(rendered, null);
  assert.equal(host.innerHTML, "");
});

test("clicking a staged approval submits one exact Main-scope owner decision", async function () {
  var modulePath = path.join(
    __dirname, "../lib/public/modules/orchestration-task-preview.js"
  );
  var previousDocument = globalThis.document;
  var previousAnimationFrame = globalThis.requestAnimationFrame;
  var previousLucide = globalThis.lucide;
  globalThis.document = { createElement: element };
  globalThis.requestAnimationFrame = function (callback) { callback(); return 1; };
  globalThis.lucide = { createIcons: function () {} };

  var preview = await import(pathToFileURL(modulePath).href);
  var storeModule = await import(pathToFileURL(path.join(
    __dirname, "../lib/public/modules/store.js"
  )).href);
  var wsModule = await import(pathToFileURL(path.join(
    __dirname, "../lib/public/modules/ws-ref.js"
  )).href);
  var sent = [];
  storeModule.createStore({
    activeCoopHome: true,
    activeSessionId: 77,
    orchestrationTaskPreviewExpanded: true,
  });
  wsModule.setWs({
    readyState: 1,
    send: function (raw) { sent.push(JSON.parse(raw)); },
  });

  try {
    var taskId = "clay-fix-approval-popup-click-noop-20260827";
    var projectId = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
    var scope = {
      portfolioTaskId: taskId,
      bindingRevision: 1,
      targetProject: { projectId: projectId },
    };
    var task = {
      taskId: "task-staged-popup-fix",
      clientRef: approvalStaging.clientRefFor(scope),
      title: "Approval: " + taskId + " revision 1",
      status: "waiting_user",
      userQuestion: approvalStaging.questionFor([scope]),
      approvalSet: {
        setId: approvalStaging.setIdFor([scope]),
        stagedAt: 100,
        scopes: [scope],
      },
    };
    var host = element("div");
    preview.renderOrchestrationTaskPreview(host, [task], { phase: "waiting_user" });
    var approve = byClass(host, "orchestration-task-approve")[0];
    assert.ok(approve, "the staged placeholder exposes an affirmative control");

    approve.click();
    approve.click();

    assert.equal(sent.length, 1, "a double click submits exactly one owner message");
    assert.deepEqual(sent[0], {
      type: "message",
      text: "Approve " + taskId + " revision 1 implementation for ProjectRef " + projectId,
      clientMessageId: sent[0].clientMessageId,
      intent: "chat",
      sessionId: 77,
      coopComposerScope: "main",
    });
    assert.match(sent[0].clientMessageId, /^cm-/);
    assert.equal(approve.disabled, true);
    assert.equal(approve.textContent, "Approval sent");
    var discovered = itemApproval.approvalEventForTask([{
      type: "user_message",
      text: sent[0].text,
      coopIngressId: "coop:popup-click:1",
      coopComposerScope: sent[0].coopComposerScope,
      _ts: 200,
    }], scope, [{
      type: "cutover_attention",
      portfolioTaskId: taskId,
      bindingRevision: 1,
      attentionKey: taskId + ":1",
      at: 100,
    }]);
    assert.equal(discovered.event.coopIngressId, "coop:popup-click:1",
      "the real named-approval route discovers the exact message produced by the click");

    wsModule.setWs(null);
    var retryHost = element("div");
    preview.renderOrchestrationTaskPreview(retryHost, [task], { phase: "waiting_user" });
    var retry = byClass(retryHost, "orchestration-task-approve")[0];
    retry.click();
    assert.equal(retry.disabled, false, "a failed send remains retryable");
    assert.match(byClass(retryHost, "orchestration-task-approval-error")[0].textContent,
      /not connected/i);
    assert.equal(sent.length, 1, "a disconnected click sends no decision");
  } finally {
    wsModule.setWs(null);
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousAnimationFrame;
    globalThis.lucide = previousLucide;
  }
});
