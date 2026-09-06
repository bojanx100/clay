var test = require("node:test"), assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");
var fs = require("fs"), os = require("os"), path = require("path");
var fixture = require("./helpers/voice-question-fixture");
var permissions = require("../lib/sdk-bridge-permissions");
function request(h, tool, input) {
  var bridge = permissions.attachBridgePermissions({ sm: h.ctx.sm, sendAndRecord: h.ctx.sm.sendAndRecord,
    onProcessingChanged: function () {}, getNotificationsModule: function () { return null; } });
  return bridge.handleCanUseTool(h.session, tool, input, { toolUseID: "real-tool", signal: new AbortController().signal });
}
test("a live provider permission is read and approved once with the existing permission settings", async function () {
  var h = fixture(); var result = request(h, "Bash", { command: "deploy preview", description: "Preview the site" });
  var found = h.snapshot().requests[0];
  assert.equal(found.kind, "permission"); assert.match(found.questions[0].question, /deploy preview/);
  assert.equal(found.confirmation, "submit decision");
  assert.equal(h.answer(found, { answers: { decision: ["Allow this request once"] } }).ok, true);
  assert.deepEqual(await result, { behavior: "allow", updatedInput: { command: "deploy preview", description: "Preview the site" } });
  assert.equal(h.session.allowedTools, undefined); assert.equal(h.ctx.sm.currentPermissionMode, undefined);
  assert.equal(h.answer(found, { answers: { decision: ["Allow this request once"] } }).ok, false);
});
test("permission input changes and wrong-session replies cannot approve a different action", async function () {
  var h = fixture(); var result = request(h, "Bash", { command: "deploy preview" });
  var found = h.snapshot().requests[0];
  h.session.pendingPermissions[found.requestId].toolInput.command = "deploy production";
  assert.equal(h.answer(found, { answers: { decision: ["Allow this request once"] } }).ok, false);
  found = h.snapshot().requests[0];
  assert.equal(h.answer(found, { sessionId: 8, answers: { decision: ["Allow this request once"] } }).ok, false);
  h.answer(found, { answers: { decision: ["Deny this request"] } });
  assert.equal((await result).behavior, "deny");
});
test("plan review discovers the current plan file; edits invalidate the old spoken decision", async function (t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-plan-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var file = path.join(root, ".claude", "plans", "review.md"); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "Keep manual project workflows. Add spoken answers.");
  var h = fixture();
  h.session.history.push({ type: "tool_start", name: "EnterPlanMode" },
    { type: "tool_executing", name: "Write", input: { file_path: file, content: "an older draft" } });
  var result = request(h, "ExitPlanMode", {}); var found = h.snapshot().requests[0];
  assert.equal(found.kind, "plan"); assert.match(found.questions[0].question, /Keep manual project workflows/);
  assert.doesNotMatch(found.questions[0].question, /older draft/);
  fs.writeFileSync(file, "Change the project workflow entirely.");
  assert.equal(h.answer(found, { answers: { decision: ["Approve this plan"] } }).ok, false);
  found = h.snapshot().requests[0]; assert.match(found.questions[0].question, /Change the project/);
  h.answer(found, { answers: { decision: ["Keep the old workflow and change only voice input"] } });
  assert.deepEqual(await result, { behavior: "deny", message: "Keep the old workflow and change only voice input" });
  assert.equal(h.starts.length, 0, "feedback reaches the blocked tool without a duplicate follow-up turn");
});
test("missing plan contents and failed decision persistence leave the permission unanswered", function () {
  var h = fixture(); request(h, "ExitPlanMode", {});
  assert.equal(h.snapshot().requests.length, 0); assert.equal(h.snapshot().blockedCount, 1);
  h = fixture(); request(h, "Bash", { command: "deploy preview" }); var found = h.snapshot().requests[0];
  h.ctx.sm.sendAndRecord = function () { return false; };
  assert.equal(h.answer(found, { answers: { decision: ["Allow this request once"] } }).ok, false);
  assert.ok(h.session.pendingPermissions[found.requestId]);
});
test("spoken decisions require their readback submission phrase and preserve conditional feedback", async function () {
  var mod = await import("../lib/public/modules/voice-questions.js");
  var h = fixture(), sent = [], spoken = [];
  var result = request(h, "ExitPlanMode", { plan: "Keep manual work unchanged. Add voice." });
  var q = mod.createVoiceQuestions({ send: function (msg) { sent.push(msg); return true; }, speak: function (text) { spoken.push(text); },
    setTimeout: function () { return 1; }, clearTimeout: function () {} });
  q.start({ sessionId: 7 }); h.send(sent[0]); q.receive(h.events.slice(-1)[0]);
  q.consume("Approve this plan only if manual work remains unchanged");
  assert.match(spoken.slice(-1)[0], /Your decision for request .*only if manual work remains unchanged.*submit decision/);
  q.consume("yes"); q.consume("submit answers"); assert.equal(sent.length, 1);
  q.consume("submit decision"); h.send(sent.slice(-1)[0]);
  assert.deepEqual(await result, { behavior: "deny", message: "Approve this plan only if manual work remains unchanged" });
  q.reset();
});
