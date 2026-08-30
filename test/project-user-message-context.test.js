var os = require("node:os");
var path = require("node:path");
var fs = require("node:fs");
var test = require("node:test");
var assert = require("node:assert/strict");

var queueModule = require("../lib/project-user-message-queue");
var contextModule = require("../lib/project-user-message-context");

function makeContext(options) {
  options = options || {};
  var cwd = options.cwd || fsTempDir();
  var session = options.session || { localId: 11, history: [], vendor: "codex" };
  var sent = [];
  var sdkCalls = [];
  var imageNumber = 0;
  var sm = {
    sessions: new Map([[session.localId, session]]),
    appendToSessionFile: function () { return options.appendResult; },
    saveSessionFile: function () { sent.push({ type: "save" }); },
    broadcastSessionList: function () {},
    queuedUserMessagesForClient: function () { return []; },
  };
  var sdk = {
    startQuery: function (target, text, images) { sdkCalls.push({ kind: "start", text: text, images: images }); },
    pushMessage: function (target, text, images) { sdkCalls.push({ kind: "push", text: text, images: images }); },
  };
  var browserState = { _browserTabList: { 7: { id: 7, title: "Docs", url: "https://docs" } } };
  var queue = queueModule.attachProjectUserMessageQueue({
    sm: sm, sdk: sdk, sendToSession: function (id, message) { sent.push(message); },
    onProcessingChanged: function () {}, onUserMessageDispatched: function () { return ""; },
    ensureProjectAccessForSession: function () {},
  });
  var context = contextModule.attachProjectUserMessageContext({
    cwd: cwd, slug: "test", sm: sm, sdk: sdk, adapter: {},
    email: options.email || null, tm: {
      getScrollback: function () {
        return { bufferStart: 0, totalBytesWritten: 12,
          chunks: [{ ts: 1000, data: "term output" }] };
      },
      list: function () { return [{ id: 4, title: "Shell" }]; },
    },
    browserState: browserState,
    requestTabContext: options.requestTabContext || function () { return Promise.resolve(null); },
    contextSourceTimeoutMs: options.contextSourceTimeoutMs,
    sendTo: function (ws, message) { sent.push(message); },
    sendToSession: function (id, message) { sent.push(message); },
    sendToSessionOthers: function () {},
    hydrateImageRefs: function (item) { return item; },
    saveImageFile: options.saveImageFile || function () { imageNumber++; return imageNumber === 1 ? "upload.png" : "shot.png"; },
    imagesDir: options.imagesDir || path.join(cwd, "images"),
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: function () {},
    loadImagesForSdk: options.loadImagesForSdk || function () { return []; },
    loadContextSources: function () { return options.sources || []; },
    getSessionForMessage: function () { return session; },
    recoverHandoffContextForSend: function () {},
    shouldQueueMessage: function () { return false; },
    queue: queue,
    hasStaleProcessingState: function () { return false; },
    coopHandoffTraceStore: { recordIntent: function () { return { ok: false }; } },
    canCaptureCoopHandoff: function () { return false; },
    handoffTraceOwnerId: function () { return "_single_user"; },
    observeAssistantTurns: function () { return function () { return 0; }; },
    usersModule: { isMultiUser: function () { return false; } },
    validateCoopTopicIngress: options.validateCoopTopicIngress,
  });
  return { context: context, session: session, sent: sent, sdkCalls: sdkCalls, cwd: cwd };
}

function fsTempDir() {
  return require("node:fs").mkdtempSync(path.join(os.tmpdir(), "clay-user-message-context-"));
}

function waitForAsyncDispatch() {
  return new Promise(function (resolve) { setTimeout(resolve, 15); });
}

test("unknown and prototype message types fall through, while empty message is consumed", function () {
  var h = makeContext();
  assert.equal(h.context.handleUserMessage({}, { type: "unknown_message", text: "do not dispatch" }), false);
  assert.equal(h.context.handleUserMessage({}, { type: "toString", text: "do not dispatch" }), false);
  assert.equal(h.context.handleUserMessage({}, { type: "message" }), true);
  assert.equal(h.session.history.length, 0);
  assert.equal(h.sdkCalls.length, 0);
});

test("canonical topic ingress rejects stale Thread refs and Main records a newly inferred route", function () {
  var seen = null;
  var session = {
    localId: 14, vendor: "codex", coopHome: true, history: [],
    coopTopicSelection: { topicRef: { topicId: "selected-topic" }, projectRef: { projectId: "system-lead" } },
  };
  var h = makeContext({
    session: session,
    validateCoopTopicIngress: function (_, msg, ws) {
      seen = { topicRef: msg.coopTopicRef, projectRef: msg.coopProjectRef };
      assert.equal(ws && ws._clayUser && ws._clayUser.id, "owner");
      return msg.coopTopicRef ? { ok: false, code: "topic_closed" } : {
        ok: true, topicRef: { topicId: "automatic-route" }, projectRef: { projectId: "system-lead" },
      };
    },
  });
  h.context.handleUserMessage({ _clayUser: { id: "owner" } }, {
    type: "message", text: "must not be written", clientMessageId: "cm-stale-topic",
    images: [{ mediaType: "image/png", data: "image-data" }], pastes: ["paste-data"],
    coopComposerScope: "topic",
    coopTopicRef: { topicId: "selected-topic" }, coopProjectRef: { projectId: "system-lead" },
  });
  assert.deepEqual(seen, {
    topicRef: { topicId: "selected-topic" }, projectRef: { projectId: "system-lead" },
  });
  assert.equal(session.history.length, 0);
  assert.equal(h.sdkCalls.length, 0);
  var failed = h.sent.find(function (message) { return message.type === "message_failed"; });
  assert.deepEqual(failed, {
    type: "message_failed", sessionId: 14, clientMessageId: "cm-stale-topic",
    reason: "topic_closed", silent: true, recoverCoopMain: true,
    coopThreadRef: null, coopTopicRef: { topicId: "selected-topic" },
    coopProjectRef: { projectId: "system-lead" },
    retryDraft: {
      text: "must not be written",
      images: [{ mediaType: "image/png", data: "image-data" }],
      pastes: ["paste-data"],
    },
    text: "The selected Coop Thread is unavailable. Coop did not fall back to another conversation or project.",
  });
  assert.equal(h.sent.some(function (message) { return message.type === "error"; }), true);

  seen = "not called";
  h.context.handleUserMessage({ _clayUser: { id: "owner" } }, {
    type: "message", text: "Main receives a new route", coopComposerScope: "main",
    coopTopicRef: { topicId: "selected-topic" }, coopProjectRef: { projectId: "system-lead" },
  });
  assert.deepEqual(seen, { topicRef: undefined, projectRef: undefined });
  assert.equal(session.history.length, 1);
  assert.deepEqual(session.history[0].coopTopicRef, { topicId: "automatic-route" });
  assert.deepEqual(session.history[0].coopProjectRef, { projectId: "system-lead" });
});

test("paste instrumentation preserves before-after field ordering", async function () {
  var h = makeContext();
  var originalLog = console.log;
  var logs = [];
  console.log = function (line) { logs.push(String(line)); };
  try {
    h.context.handleUserMessage({}, { type: "message", text: "hello", pastes: ["paste"] });
    await waitForAsyncDispatch();
  } finally {
    console.log = originalLog;
  }
  assert.ok(logs.some(function (line) {
    return line === "[clay-paste] handleUserMessage: session=11 steer=false wasProcessing=false pastes=1 pasteChars=5 fullTextLen 5->12";
  }));
});

test("ordinary message preparation preserves echo/title/image/paste and terminal-email-browser ordering", async function () {
  var h = makeContext({
    sources: ["term:4", "email:inbox", "tab:7"],
    email: { getEmailContext: function () { return Promise.resolve("email context"); } },
    requestTabContext: function () {
      return Promise.resolve({
        console: { logs: [{ level: "warn", text: "console line", ts: 1000 }] },
        network: { network: [{ method: "GET", url: "https://api", status: 200, duration: 4 }] },
        pageText: { text: "page text" },
        screenshot: { image: "shot-data" },
      });
    },
  });
  h.context.handleUserMessage({ _clayActiveSession: 11 }, {
    type: "message", text: "hello", pastes: ["pasted block"],
    images: [{ mediaType: "image/png", data: "upload-data" }],
  });
  await waitForAsyncDispatch();
  assert.equal(h.session.title, "hello");
  assert.deepEqual(h.session.history[0].pastes, ["pasted block"]);
  assert.deepEqual(h.session.history[0].imageRefs, [{ mediaType: "image/png", file: "upload.png" }]);
  assert.ok(h.sent.some(function (message) { return message.type === "user_message"; }));
  assert.ok(h.sent.some(function (message) { return message.type === "context_preview"; }));
  assert.equal(h.sdkCalls.length, 1);
  var text = h.sdkCalls[0].text;
  assert.match(text, /console line/);
  assert.match(text, /https:\/\/api/);
  assert.match(text, /page text/);
  assert.match(text, /email context/);
  assert.match(text, /term output/);
  assert.match(text, /pasted block/);
  assert.match(text, /Uploaded image:/);
  assert.ok(text.indexOf("console line") < text.indexOf("email context"));
  assert.ok(text.indexOf("email context") < text.indexOf("term output"));
});

test("a browser context source cannot strand an accepted message", async function () {
  var h = makeContext({
    sources: ["tab:7"],
    contextSourceTimeoutMs: 5,
    requestTabContext: function () {
      return new Promise(function () {});
    },
  });
  h.context.handleUserMessage({}, { type: "message", text: "dispatch even if the tab hangs", clientMessageId: "cm-timeout" });
  await new Promise(function (resolve) { setTimeout(resolve, 20); });
  assert.equal(h.sdkCalls.length, 1, "the prepared message dispatches after optional context times out");
  assert.equal(h.sdkCalls[0].text, "dispatch even if the tab hangs");
});

test("message acknowledgement follows durable append and persistence failure stops dispatch", async function () {
  var accepted = makeContext();
  accepted.context.handleUserMessage({}, { type: "message", text: "saved", clientMessageId: "cm-accepted" });
  assert.equal(accepted.sent[0].type, "message_accepted");
  assert.equal(accepted.sent[0].clientMessageId, "cm-accepted");

  var failed = makeContext({ appendResult: false });
  failed.context.handleUserMessage({}, { type: "message", text: "not saved", clientMessageId: "cm-failed" });
  assert.equal(failed.sent.some(function (message) { return message.type === "message_failed"; }), true);
  await waitForAsyncDispatch();
  assert.equal(failed.sdkCalls.length, 0, "provider dispatch waits for persistence");
});

test("handoff preparation wraps and consumes context, while provider API-error retry rewrites only agent text", async function () {
  var session = {
    localId: 12, vendor: "codex", history: [],
    handoffContext: "<clay_handoff_context>prior</clay_handoff_context>",
    handoffContextTurnsRemaining: 1,
  };
  var h = makeContext({ session: session });
  h.context.handleUserMessage({}, { type: "message", text: "continue" });
  await waitForAsyncDispatch();
  assert.equal(h.sdkCalls.length, 1);
  assert.match(h.sdkCalls[0].text, /<current_user_message>/);
  assert.match(h.sdkCalls[0].text, /continue/);
  assert.equal(session.handoffContext, null);
  assert.equal(session.handoffContextConsumed, true);

  var retrySession = {
    localId: 13, vendor: "codex",
    history: [
      { type: "user_message", text: "original", imageRefs: [{ mediaType: "image/png", file: "upload.png" }] },
      { type: "error", text: "API Error: provider unavailable" },
    ],
  };
  var retry = makeContext({
    session: retrySession,
    loadImagesForSdk: function(refs) {
      assert.deepEqual(refs, [{ mediaType: "image/png", file: "upload.png" }]);
      return [{ mediaType: "image/png", data: "retry-image", savedPath: "/tmp/upload.png" }];
    },
  });
  retry.context.handleUserMessage({}, { type: "message", text: "continue" });
  await waitForAsyncDispatch();
  assert.match(retry.sdkCalls[0].text, /Retry the previous provider\/API failure/);
  assert.doesNotMatch(retry.sdkCalls[0].text, /^continue$/);
  assert.deepEqual(retry.sdkCalls[0].images, [{ mediaType: "image/png", data: "retry-image", savedPath: "/tmp/upload.png" }]);
  assert.deepEqual(retrySession.history.at(-1).imageRefs, [{ mediaType: "image/png", file: "upload.png" }]);
  assert.equal(retrySession.history.at(-1).apiErrorImageRetry, true);
});

test("a corrupt Codex upload stays attached and produces a precise warning", async function (t) {
  var cwd = fsTempDir();
  var imagesDir = path.join(cwd, "images");
  var corruptPath = path.join(imagesDir, "corrupt.png");
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(corruptPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  t.after(function() { fs.rmSync(cwd, { recursive: true, force: true }); });
  var h = makeContext({
    cwd: cwd,
    imagesDir: imagesDir,
    saveImageFile: function () { return "corrupt.png"; },
  });

  h.context.handleUserMessage({}, {
    type: "message",
    text: "Inspect this",
    images: [{ mediaType: "image/png", data: "corrupt" }],
  });
  await waitForAsyncDispatch();

  assert.deepEqual(h.session.history[0].imageRefs, [{ mediaType: "image/png", file: "corrupt.png" }]);
  assert.equal(h.session.history[0].imageDeliveryWarnings.length, 1);
  assert.match(h.sent.find(function(message) { return message.type === "info"; }).text, /invalid PNG data/);
  assert.deepEqual(h.sdkCalls[0].images, [{
    mediaType: "image/png",
    data: "corrupt",
    savedPath: corruptPath,
  }]);
});

test("an API-error retry keeps an unavailable image reference with a deterministic fallback", async function () {
  var retrySession = {
    localId: 15,
    vendor: "codex",
    history: [
      { type: "user_message", text: "original", imageRefs: [{ mediaType: "image/png", file: "missing.png" }] },
      { type: "error", text: "API Error: image rejected" },
    ],
  };
  var retry = makeContext({
    session: retrySession,
    loadImagesForSdk: function() { return []; },
  });

  retry.context.handleUserMessage({}, { type: "message", text: "continue" });
  await waitForAsyncDispatch();

  assert.equal(retry.sdkCalls[0].images, undefined);
  assert.match(retry.sdkCalls[0].text, /could not reload its original file for this API-error retry/);
  assert.deepEqual(retrySession.history.at(-1).imageRefs, [{ mediaType: "image/png", file: "missing.png" }]);
  assert.equal(retrySession.history.at(-1).apiErrorImageRetryFallback, true);
  assert.match(retry.sent.find(function(message) { return message.type === "info"; }).text, /The image was not removed/);
});
