var test = require("node:test");
var assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");
var dialogs = require("../lib/sdk-bridge-dialogs");
var fixture = require("./helpers/voice-question-fixture");

test("current pending questions are discovered from live state, not old cards", function () {
  var h = fixture(); h.add("live");
  h.session.history.push({ type: "tool_executing", name: "AskUserQuestion", id: "obsolete", input: { questions: [{ question: "Old question" }] } });
  var snapshot = h.snapshot();
  assert.deepEqual(snapshot.requests.map(function (item) { return item.requestId; }), ["live"]);
  assert.equal(snapshot.requests[0].questions[0].question, "Which approach?");
  assert.equal(snapshot.requests[0].revision, h.snapshot().requests[0].revision);
});

test("Claude stateless answers use the ordinary owner-message path and carry voice turn identity", function () {
  var h = fixture(); h.add("claude"); h.session.isProcessing = true;
  assert.equal(h.answer(h.snapshot().requests[0]).ok, true);
  assert.equal(h.starts.length, 1);
  assert.match(h.starts[0].text, /Which approach\? → Keep it simple/);
  assert.equal(h.starts[0].clientMessageId, "answer-1");
  assert.equal(h.starts[0].ingressType, "voice");
  assert.equal(h.session.pendingAskUser.claude, undefined);
  assert.equal(h.events.some(function (e) { return e.type === "user_turn_started"; }), false,
    "the ordinary queue, not early answer acceptance, attributes the next SDK turn");
});

test("Claude native blocking answers resolve the exact callback without starting a duplicate query", function () {
  var h = fixture(); h.add("native", "native");
  assert.equal(h.answer(h.snapshot().requests[0]).ok, true);
  assert.equal(h.resolved.length, 1); assert.equal(h.starts.length, 0);
  assert.match(h.resolved[0].message, /Keep it simple/);
  assert.equal(h.events.find(function (e) { return e.type === "user_turn_started"; }).clientMessageId, "answer-1");
});

test("stale, replaced, modified, duplicate and wrong-session voice answers cannot fall through to new chat", function () {
  ["removed", "replaced", "modified", "wrong_session", "duplicate"].forEach(function (change) {
    var h = fixture(); h.add("live"); var original = h.snapshot().requests[0];
    if (change === "removed") delete h.session.pendingAskUser.live;
    if (change === "replaced") h.add("live");
    if (change === "modified") h.session.pendingAskUser.live.input.questions[0].question = "A different decision?";
    if (change === "duplicate") assert.equal(h.answer(original).ok, true);
    var before = h.starts.length;
    assert.equal(h.answer(original, change === "wrong_session" ? { sessionId: 8 } : {}).ok, false);
    assert.equal(h.starts.length, before);
  });
});

test("Codex pending questions from the real dialog bridge resolve the exact request once", async function () {
  var h = fixture(); var abort = new AbortController();
  var bridge = dialogs.attachBridgeDialogs({ sendAndRecord: h.ctx.sm.sendAndRecord });
  var resultPromise = bridge.handleElicitation(h.session, { questionKind: "codex_user_input",
    questions: [{ id: "approach", question: "Which approach?", options: [{ label: "Keep it simple" }, { label: "Rebuild" }] }] }, { signal: abort.signal });
  var found = h.snapshot().requests[0];
  assert.equal(found.kind, "codex_user_input");
  assert.equal(h.answer(found, { answers: { approach: ["Keep it simple"] } }).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await resultPromise)), { action: "accept", content: { approach: "Keep it simple" } });
  assert.equal(h.answer(found, { answers: { approach: ["Rebuild"] } }).ok, false);
});

test("private questions and arbitrary permissions/forms are excluded from spoken answers", function () {
  var h = fixture();
  h.session.pendingPermissions.permission = { toolName: "Bash" };
  h.session.pendingElicitations.form = { request: { requestedSchema: { properties: { password: { type: "string" } } } } };
  h.session.pendingElicitations.secret = { request: { questionKind: "codex_user_input", questions: [{ id: "secret", question: "Password?", isSecret: true }] } };
  var snapshot = h.snapshot();
  assert.equal(snapshot.requests.length, 0);
  assert.equal(snapshot.blockedCount, 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /Password|password|Bash/);
});

test("a cancelled provider question disappears from live Voice and emits resolution", async function () {
  var h = fixture(), ac = new AbortController();
  var bridge = dialogs.attachBridgeDialogs({ sendAndRecord: h.ctx.sm.sendAndRecord });
  var result = bridge.handleElicitation(h.session, { questionKind: "codex_user_input", questions: [{ id: "a", question: "Approach?" }] }, { signal: ac.signal });
  var before = h.snapshot(); assert.equal(before.requests.length, 1);
  ac.abort(); assert.deepEqual(await result, { action: "reject" });
  assert.equal(h.snapshot().requests.length, 0);
  assert.ok(h.events.some(function (event) { return event.type === "elicitation_resolved"; }));
});
