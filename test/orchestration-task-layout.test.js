var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var approvalStaging = require("../lib/coop-approval-question-staging");
var itemApproval = require("../lib/coop-item-approval");
var coopConversationControl = require("../lib/coop-conversation-control");
var orchestrationTasksForClient =
  require("../lib/orchestration-task-state").orchestrationTasksForClient;

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

test("client task projection retains only validated canonical worker SessionRefs", function () {
  var validRef = {
    projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
    sessionStorageId: "canonical-session",
  };
  var projected = orchestrationTasksForClient({ orchestrationTasks: [{
    taskId: "valid-ref",
    workerSessionId: 14,
    workerSessionRef: Object.assign({ ignored: "server-only" }, validRef),
  }, {
    taskId: "malformed-ref",
    workerSessionId: 15,
    workerSessionRef: { projectId: validRef.projectId },
  }, {
    taskId: "same-project-no-ref",
    workerSessionId: 16,
  }] });

  assert.deepEqual(projected[0].workerSessionRef, validRef,
    "the client receives the exact normalized cross-project identity");
  assert.equal(projected[1].workerSessionRef, null,
    "an incomplete represented ref is never partially projected");
  assert.equal(projected[1].workerSessionId, null,
    "a malformed represented ref cannot fall through to project-local navigation");
  assert.equal(projected[2].workerSessionRef, null);
  assert.equal(projected[2].workerSessionId, 16,
    "a genuine same-project task without a ref retains its local fallback");
});

test("cross-project task preview resolves its canonical session for pointer and keyboard activation", async function () {
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
  storeModule.createStore({ orchestrationTaskPreviewExpanded: true });
  wsModule.setWs({
    readyState: 1,
    send: function (raw) { sent.push(JSON.parse(raw)); },
  });

  try {
    var sessionRef = {
      projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "canonical-worker-session",
    };
    var question = "Should the owner approve this task after reviewing the full canonical worker transcript?";
    var task = orchestrationTasksForClient({ orchestrationTasks: [{
      taskId: "cross-project-task",
      title: "Correct Coop task activation",
      status: "waiting_user",
      workerSessionId: 14,
      workerSessionRef: sessionRef,
      userQuestion: question,
      createdAt: 10,
      updatedAt: 20,
    }] })[0];
    var originalTask = JSON.parse(JSON.stringify(task));
    var host = element("div");
    preview.renderOrchestrationTaskPreview(host, [task], { phase: "waiting_user" });
    var row = byClass(host, "orchestration-task-item")[0];
    var detail = byClass(row, "orchestration-task-detail")[0];
    var title = byClass(row, "orchestration-task-title")[0];

    assert.equal(row.attributes.role, "button");
    assert.equal(row.tabIndex, 0);
    assert.equal(detail.textContent, "Decision needed",
      "the narrow visible row exposes only the compact waiting status");
    assert.equal(row.textContent.indexOf(question), -1,
      "the full pending question is absent from visible card text");
    assert.match(title.title, new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the full question remains available as tooltip context");

    row.click();
    var keyHandler = row.listeners.keydown[0];
    var prevented = 0;
    keyHandler({ key: "Enter", preventDefault: function () { prevented++; } });
    keyHandler({ key: " ", preventDefault: function () { prevented++; } });

    var expected = {
      type: "resolve_session_ref",
      sessionRef: sessionRef,
      scope: "owner_request_hierarchy",
    };
    assert.deepEqual(sent, [expected, expected, expected],
      "pointer, Enter, and Space all use the ACL-scoped exact-session resolver");
    assert.equal(sent.some(function (message) { return message.type === "switch_session"; }), false,
      "a represented canonical ref never falls through to a current-project numeric switch");
    assert.equal(prevented, 2);
    assert.deepEqual(task, originalTask,
      "navigation does not mutate the projected task lifecycle state");

    sent.length = 0;
    var fallbackHost = element("div");
    preview.renderOrchestrationTaskPreview(fallbackHost, [{
      taskId: "same-project-no-ref",
      title: "Local worker",
      status: "running",
      workerSessionId: 16,
      workerSessionRef: null,
    }], { phase: "executing" });
    byClass(fallbackHost, "orchestration-task-item")[0].click();
    assert.deepEqual(sent, [{ type: "switch_session", id: 16 }],
      "the raw numeric route remains only for a genuine no-ref local task");
  } finally {
    wsModule.setWs(null);
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousAnimationFrame;
    globalThis.lucide = previousLucide;
  }
});

test("serialized staged approval clicks one exact Main-scope owner decision", async function () {
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
      bindingRevision: 2,
      targetProject: { projectId: projectId },
    };
    var approvalSet = {
      setId: approvalStaging.setIdFor([scope]),
      stagedAt: 100,
      scopes: [scope],
    };
    var stagedInput = approvalStaging.stagedTaskInput(
      scope,
      approvalSet,
      approvalStaging.questionFor([scope]),
      "owner_implementation_decision_required"
    );
    var serverTask = Object.assign({
      taskId: "task-staged-popup-fix-r2",
      status: "waiting_user",
      createdAt: 100,
      updatedAt: 100,
    }, stagedInput);
    var task = JSON.parse(JSON.stringify(
      orchestrationTasksForClient({ orchestrationTasks: [serverTask] })[0]
    ));
    var mismatchedTask = JSON.parse(JSON.stringify(orchestrationTasksForClient({
      orchestrationTasks: [Object.assign({}, serverTask, {
        clientRef: "portfolio:other-task:2",
      })],
    })[0]));
    var mismatchedHost = element("div");
    preview.renderOrchestrationTaskPreview(
      mismatchedHost,
      [mismatchedTask],
      { phase: "waiting_user" }
    );
    assert.equal(byClass(mismatchedHost, "orchestration-task-approve").length, 0,
      "a serialized clientRef outside the staged scope remains fail-closed");
    var host = element("div");
    preview.renderOrchestrationTaskPreview(host, [task], { phase: "waiting_user" });
    var approve = byClass(host, "orchestration-task-approve")[0];
    assert.ok(approve, "the staged placeholder exposes an affirmative control");

    approve.click();
    approve.click();

    // A projection can re-render the still-pending placeholder before the
    // coordinator has consumed the approval. That must remain the same
    // single-flight action, not create a fresh DOM-local approval button.
    var rerenderHost = element("div");
    preview.renderOrchestrationTaskPreview(rerenderHost, [task], { phase: "waiting_user" });
    var rerenderApprove = byClass(rerenderHost, "orchestration-task-approve")[0];
    rerenderApprove.click();

    assert.equal(sent.length, 1,
      "double clicks and a re-rendered second control submit exactly one owner message");
    assert.deepEqual(sent[0], {
      type: "message",
      text: "Approve " + taskId + " revision 2 implementation for ProjectRef " + projectId,
      clientMessageId: sent[0].clientMessageId,
      intent: "chat",
      sessionId: 77,
      coopComposerScope: "main",
    });
    assert.equal(sent[0].clientMessageId,
      "coop-approval:" + approvalSet.setId + ":" + task.clientRef,
      "the exact staged task/revision keeps one stable ingress identity across retries");
    var ingressSession = { coopHome: true, storageId: "approval-replay", history: [] };
    var acceptedIngress = coopConversationControl.reserveIngress(ingressSession, sent[0]);
    ingressSession.history.push({
      type: "user_message",
      coopIngressKey: "input:" + sent[0].clientMessageId,
      coopIngressId: acceptedIngress.ingressId,
      coopIngressSequence: acceptedIngress.sequence,
    });
    delete ingressSession.coopConversationIngress;
    var replayedIngress = coopConversationControl.reserveIngress(ingressSession,
      Object.assign({}, sent[0]));
    assert.equal(replayedIngress.duplicate, true,
      "the server recognizes the real approval request as one durable ingress after restart");
    assert.equal(replayedIngress.ingressId, acceptedIngress.ingressId);
    var revisionScope = Object.assign({}, scope, { bindingRevision: 3 });
    var revisionApprovalSet = {
      setId: approvalStaging.setIdFor([revisionScope]),
      stagedAt: 100,
      scopes: [revisionScope],
    };
    var revisionTask = JSON.parse(JSON.stringify(orchestrationTasksForClient({
      orchestrationTasks: [Object.assign({
        taskId: "task-staged-popup-fix-r3",
        status: "waiting_user",
        createdAt: 100,
        updatedAt: 100,
      }, approvalStaging.stagedTaskInput(
        revisionScope,
        revisionApprovalSet,
        approvalStaging.questionFor([revisionScope]),
        "owner_implementation_decision_required"
      ))],
    })[0]));
    var revisionHost = element("div");
    preview.renderOrchestrationTaskPreview(revisionHost, [revisionTask], { phase: "waiting_user" });
    byClass(revisionHost, "orchestration-task-approve")[0].click();
    assert.equal(sent.length, 2,
      "a distinct binding revision remains independently approvable");
    assert.notEqual(sent[1].clientMessageId, sent[0].clientMessageId,
      "each exact staged task/revision has its own durable ingress identity");
    assert.equal(approve.disabled, true);
    assert.equal(approve.textContent, "Approval sent");
    assert.equal(rerenderApprove.disabled, true,
      "the re-rendered control stays disabled while the same approval is in flight");
    assert.equal(byClass(host, "orchestration-task-approve").length, 1,
      "a successful socket write keeps the staged control until server confirmation");
    var discovered = itemApproval.approvalEventForTask([{
      type: "user_message",
      text: sent[0].text,
      coopIngressId: "coop:popup-click:1",
      coopComposerScope: sent[0].coopComposerScope,
      _ts: 200,
    }], scope, [{
      type: "cutover_attention",
      portfolioTaskId: taskId,
      bindingRevision: 2,
      attentionKey: taskId + ":2",
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
    assert.equal(sent.length, 2, "a disconnected click sends no decision");

    wsModule.setWs({
      readyState: 1,
      send: function (raw) { sent.push(JSON.parse(raw)); },
    });
    retry.click();
    retry.click();
    assert.equal(sent.length, 3, "the same control retries once after transport recovery");
    assert.equal(sent[2].text,
      "Approve " + taskId + " revision 2 implementation for ProjectRef " + projectId);
    assert.equal(retry.disabled, true);
    assert.equal(byClass(retryHost, "orchestration-task-approval-error")[0].textContent, "");

    var completedTask = JSON.parse(JSON.stringify(orchestrationTasksForClient({
      orchestrationTasks: [Object.assign({}, serverTask, {
        status: "completed",
        updatedAt: 200,
      })],
    })[0]));
    preview.renderOrchestrationTaskPreview(host, [completedTask], { phase: "complete" });
    assert.equal(byClass(host, "orchestration-task-approve").length, 0,
      "authoritative completion removes the staged control");
  } finally {
    wsModule.setWs(null);
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousAnimationFrame;
    globalThis.lucide = previousLucide;
  }
});
