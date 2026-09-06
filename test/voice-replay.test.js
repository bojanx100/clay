var test = require("node:test"), assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");
var fs = require("fs"), os = require("os"), path = require("path");
var replay = require("../lib/voice-turn-replay");
var queueModule = require("../lib/project-user-message-queue");
var fixture = require("./helpers/voice-question-fixture");
test("actual dispatch and response recording survive transcript reload and recover only the requested reply", function (t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-replay-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var file = path.join(root, "session.jsonl"), session = { localId: 7, history: [], isProcessing: false }, dispatched = 0;
  var io = require("../lib/sessions-io").attachSessionIo({
    appendToSessionFile: function (s, event) { fs.appendFileSync(file, JSON.stringify(event) + "\n"); return true; },
    isMeaninglessUnknownError: function () { return false; }, sendEach: function () {}, onSessionDone: function () {} });
  var deps = { sm: { sendAndRecord: io.sendAndRecord, broadcastSessionList: function () {} },
    sdk: { startQuery: function () { dispatched++; } }, sendToSession: function () {},
    onProcessingChanged: function () {}, ensureProjectAccessForSession: function () {} };
  var queue = queueModule.attachProjectUserMessageQueue(deps);
  ["earlier", "voice-owner", "later"].forEach(function (id) {
    queue.dispatchPreparedToSdk(session, { finalText: id, clientMessageId: id, intent: "chat" });
    io.sendAndRecord(session, { type: "delta", text: "Initial " });
    io.sendAndRecord(session, { type: "delta_replace", text: "The reply to " + id });
    io.sendAndRecord(session, { type: "tool_result", text: "secret technical output" });
    io.sendAndRecord(session, { type: "done" });
  });
  assert.equal(dispatched, 3);
  var restored = { localId: 7, history: fs.readFileSync(file, "utf8").trim().split("\n").map(function (line) { return JSON.parse(line); }) };
  assert.deepEqual(replay.read(restored, "voice-owner"), { state: "completed", text: "The reply to voice-owner" });
  assert.equal(replay.read(restored, "missing").state, "unknown");
});
test("recovery distinguishes queued, failed, interrupted and another session without manufacturing completion", function () {
  var h = fixture();
  h.session.pendingUserMessageQueue = [{ clientMessageId: "queued" }];
  assert.equal(replay.read(h.session, "queued").state, "queued");
  replay.recordStart(h.session, "voice", h.ctx);
  h.session.history.push({ type: "delta", text: "Partial reply" }, { type: "user_message", internalOnly: true, text: "Internal polling" }, { type: "done" });
  assert.deepEqual(replay.read(h.session, "voice"), { state: "interrupted", text: "Partial reply" });
  replay.recordStart(h.session, "failed", h.ctx);
  h.session.history.push({ type: "error", text: "Provider unavailable" }, { type: "done", code: 1 });
  assert.deepEqual(replay.read(h.session, "failed"), { state: "failed", text: "Provider unavailable" });
  h.send({ type: "voice_turn_state_request", sessionId: 8, clientMessageId: "failed", clientRequestId: "inspect" });
  var response = h.events.slice(-1)[0]; assert.equal(response.state, "unavailable"); assert.doesNotMatch(response.text, /Provider/);
});
test("a failed dispatch-marker write cannot start a provider turn", function () {
  var started = 0, events = [];
  var q = queueModule.attachProjectUserMessageQueue({ sm: { sendAndRecord: function () { return false; } },
    sdk: { startQuery: function () { started++; } }, sendToSession: function (id, event) { events.push(event); } });
  q.dispatchPreparedToSdk({ localId: 7, history: [] }, { finalText: "work", clientMessageId: "voice", intent: "chat" });
  assert.equal(started, 0); assert.equal(events.slice(-1)[0].type, "message_failed");
});
