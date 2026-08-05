var test = require("node:test");
var assert = require("node:assert/strict");
var handlersModule = require("../lib/project-user-message-handlers");

function makeHarness() {
  var sent = [];
  var calls = [];
  var permissions = { terminal: true, scheduledTasks: true, sessionDelete: true };
  var session = { localId: 3, pendingUserMessageQueue: [], history: [], isProcessing: false };
  var browserState = { _browserTabList: {}, _extensionWs: null, pendingExtensionRequests: {} };
  var queue = {
    sendQueuedUserMessagesState: function () { calls.push("queue-state"); },
    markQueuedHistoryAsSteered: function () { calls.push("mark-steer"); return null; },
    markQueuedHistoryAsCoordinated: function () { calls.push("mark-coordinate"); return null; },
    queuePreparedMessage: function (target, text, images, id) {
      calls.push("queue:" + text);
      target.pendingUserMessageQueue.unshift({ queueId: id, text: text });
    },
    flushQueuedUserMessage: function () { calls.push("flush"); },
    removeQueuedHistoryMessage: function () { calls.push("remove"); },
  };
  var loop = { handleLoopMessage: function () { calls.push("loop"); return false; } };
  var api = handlersModule.attachProjectUserMessageHandlers({
    cwd: process.cwd(), slug: "test", isMate: false, osUsers: false,
    sm: {
      saveSessionFile: function () { calls.push("save"); },
      broadcastSessionList: function () { calls.push("broadcast"); },
    },
    nm: {
      create: function () { calls.push("note-create"); return { id: "n1" }; },
      update: function () { calls.push("note-update"); return { id: "n1" }; },
      remove: function () { calls.push("note-delete"); return true; },
      list: function () { return [{ id: "n1" }]; },
      bringToFront: function () { calls.push("note-front"); return { id: "n1" }; },
      getActiveNotesText: function () { return ""; },
    },
    tm: {
      create: function () { calls.push("term-create"); return { id: 8 }; },
      attach: function () { calls.push("term-attach"); }, detach: function () { calls.push("term-detach"); },
      write: function () { calls.push("term-input"); }, resize: function () { calls.push("term-resize"); },
      close: function () { calls.push("term-close"); }, rename: function () { calls.push("term-rename"); },
      list: function () { return []; },
    },
    send: function (message) { sent.push(message); },
    sendTo: function (ws, message) { sent.push(message); },
    sendToSession: function (id, message) { sent.push(message); },
    usersModule: {
      getEffectivePermissions: function () { return permissions; },
    },
    getOsUserInfoForWs: function () { return null; },
    getLinuxUserForSession: function () { return null; },
    saveImageFile: function () { calls.push("save-image"); return "scheduled.png"; },
    loadContextSources: function () { return []; }, saveContextSources: function () {},
    browserState: browserState, scheduleMessage: function () { calls.push("schedule"); },
    cancelScheduledMessage: function () { calls.push("cancel"); },
    sendScheduledMessageNow: function () { calls.push("send-now"); },
    getSessionForMessage: function () { return session; },
    getSessionForMessageWithoutSwitch: function () { return session; },
    queue: queue, hydrateImageRefs: function (item) { return item; }, _loop: loop,
    coordinateQueuedMessage: function () { calls.push("coordinate"); return { ok: true }; },
    closeOrchestrationTask: function () { calls.push("close-task"); },
    retryOrchestrationReconciliation: function () { calls.push("retry"); },
    listAdoptionCoordinators: function () { calls.push("list-coordinators"); return [{ id: 9 }]; },
    proposeSessionAdoption: function () { calls.push("propose"); return true; },
  });
  return { api: api, sent: sent, calls: calls, permissions: permissions,
    session: session, browserState: browserState, loop: loop };
}

test("own-property-safe auxiliary dispatch falls through inherited names", function () {
  var h = makeHarness();
  assert.equal(h.api.handleAuxiliaryMessage({}, { type: "toString" }), false);
  assert.equal(h.api.handleAuxiliaryMessage({}, { type: "unknown_message" }), false);
  assert.equal(h.calls.includes("note-create"), false);
  assert.equal(h.api.handleAuxiliaryMessage({}, { type: "note_create" }), true);
  assert.equal(h.calls.includes("note-create"), true);
});

test("notes, terminal permissions, and browser extension connect/disconnect/result routes work", async function () {
  var h = makeHarness();
  h.api.handleAuxiliaryMessage({}, { type: "note_create" });
  h.api.handleAuxiliaryMessage({}, { type: "note_update", id: "n1", text: "updated" });
  h.api.handleAuxiliaryMessage({}, { type: "note_delete", id: "n1" });
  h.api.handleAuxiliaryMessage({}, { type: "note_list_request" });
  h.api.handleAuxiliaryMessage({}, { type: "note_bring_front", id: "n1" });
  h.permissions.terminal = false;
  h.api.handleAuxiliaryMessage({ _clayUser: { id: "u" } }, { type: "term_create" });
  assert.match(h.sent.at(-1).error, /Terminal access/);
  h.permissions.terminal = true;
  h.api.handleAuxiliaryMessage({ _clayUser: { id: "u" } }, { type: "term_create" });
  assert.ok(h.calls.includes("term-create"));

  var extensionWs = { readyState: 1 };
  h.api.handleAuxiliaryMessage(extensionWs, {
    type: "browser_tab_list", extensionId: "ext-1", tabs: [{ id: 42, title: "Docs" }],
  });
  assert.equal(h.browserState._extensionWs, extensionWs);
  assert.equal(h.browserState._browserTabList[42].title, "Docs");
  var result;
  h.browserState.pendingExtensionRequests.req = {
    timer: setTimeout(function () {}, 1000), resolve: function (value) { result = value; },
  };
  h.api.handleAuxiliaryMessage(extensionWs, { type: "extension_result", requestId: "req", result: { ok: true } });
  assert.deepEqual(result, { ok: true });
  h.api.handleAuxiliaryMessage(extensionWs, { type: "browser_tab_list", connected: false });
  assert.equal(h.browserState._extensionWs, null);
  assert.deepEqual(h.browserState._browserTabList, {});
});

test("loop permission and delegation, adoption, close-task, and scheduling routes preserve gates", function () {
  var h = makeHarness();
  h.permissions.scheduledTasks = false;
  assert.equal(h.api.handleAuxiliaryMessage({ _clayUser: { id: "u" } }, { type: "loop_start" }), true);
  assert.match(h.sent.at(-1).text, /Scheduled tasks/);
  assert.equal(h.calls.includes("loop"), false);
  h.permissions.scheduledTasks = true;
  h.api.handleAuxiliaryMessage({ _clayUser: { id: "u" } }, { type: "loop_start" });
  assert.equal(h.calls.includes("loop"), true);

  h.api.handleAuxiliaryMessage({}, { type: "list_orchestration_coordinators", sourceSessionId: 3 });
  h.api.handleAuxiliaryMessage({}, { type: "propose_session_adoption", sourceSessionId: 3, coordinatorSessionId: 9 });
  h.api.handleAuxiliaryMessage({ _clayUser: { id: "u" } }, { type: "close_orchestration_task", taskId: "task-1" });
  assert.ok(h.calls.includes("list-coordinators"));
  assert.ok(h.calls.includes("propose"));
  assert.ok(h.calls.includes("close-task"));

  h.api.handleAuxiliaryMessage({}, {
    type: "schedule_message", text: "scheduled", resetsAt: 123,
    images: [{ mediaType: "image/png", data: "abc" }],
  });
  h.api.handleAuxiliaryMessage({}, { type: "cancel_scheduled_message" });
  h.api.handleAuxiliaryMessage({}, { type: "send_scheduled_now" });
  assert.ok(h.calls.includes("save-image"));
  assert.ok(h.calls.includes("schedule"));
  assert.ok(h.calls.includes("cancel"));
  assert.ok(h.calls.includes("send-now"));
});

test("queue steer, coordinate, clear, and toggle route through queue state helpers", function () {
  var h = makeHarness();
  h.session.pendingUserMessageQueue.push({ queueId: "q1", text: "queued" });
  h.api.handleAuxiliaryMessage({}, { type: "steer_queued_message", queueId: "q1" });
  assert.ok(h.calls.includes("queue:queued"));
  h.api.handleAuxiliaryMessage({}, { type: "coordinate_queued_message", queueId: "q1" });
  h.api.handleAuxiliaryMessage({}, { type: "set_session_queueing", disabled: true });
  h.api.handleAuxiliaryMessage({}, { type: "clear_queued_message", queueId: "q1" });
  assert.equal(h.session.queueingDisabled, true);
  assert.ok(h.calls.includes("remove"));
});
