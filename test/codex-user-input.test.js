var test = require("node:test");
var assert = require("node:assert/strict");
require("./helpers/isolated-clay-home");
var adapter = require("../lib/yoke/adapters/codex");
var dialogs = require("../lib/sdk-bridge-dialogs");
var fixture = require("./helpers/voice-question-fixture");
function settle() { return new Promise(function (resolve) { setImmediate(resolve); }); }
async function harness(t) {
  var h = fixture(), listener, started, responses = [];
  var ready = new Promise(function (resolve) { started = resolve; });
  var bridge = dialogs.attachBridgeDialogs({ sendAndRecord: h.ctx.sm.sendAndRecord });
  var server = { started: true, subscribe: function (fn) { listener = fn; return function () {}; },
    send: function (method) {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "voice-thread" } });
      if (method === "turn/start") started();
      return Promise.resolve({});
    }, respond: function (id, result) { responses.push({ id: id, result: JSON.parse(JSON.stringify(result)) }); } };
  var handle = adapter.contractTestKit.createQueryHandle(server, { cwd: process.cwd(), model: "gpt-6-astra",
    abortController: new AbortController(),
    onElicitation: function (request, opts) { return bridge.handleElicitation(h.session, request, opts); } });
  handle.pushMessage("Ask me about the approach"); await ready; await settle();
  function emit(method, params, id) { listener({ method: method, id: id, params: Object.assign({ threadId: "voice-thread" }, params) }); }
  emit("turn/started", { turn: { id: "voice-turn", status: "inProgress" } });
  t.after(async function () { emit("turn/completed", { turn: { id: "voice-turn", status: "completed", items: [] } }); handle.close(); await settle(); });
  return { h: h, emit: emit, responses: responses, handle: handle,
    ask: async function () {
      emit("item/tool/requestUserInput", { turnId: "voice-turn", itemId: "question-tool",
        questions: [{ id: "approach", header: "Approach", question: "Which approach?", isOther: false,
          options: [{ label: "Keep it simple", description: "Small change" }, { label: "Rebuild", description: "More work" }] }] }, 42);
      await settle(); return h.snapshot().requests[0];
    } };
}

test("actual Codex request_user_input resolves through Clay's live question path with the installed protocol shape", async function (t) {
  var f = await harness(t); var request = await f.ask();
  assert.ok(request, "the real adapter callback must expose its live question");
  assert.equal(request.kind, "codex_user_input");
  f.h.answer(request, { answers: { approach: ["Keep it simple"] } }); await settle();
  assert.deepEqual(f.responses, [{ id: 42, result: { answers: { approach: { answers: ["Keep it simple"] } } } }]);
  assert.equal(f.h.starts.length, 0, "a blocking Codex answer resumes the existing provider request");
  assert.equal(f.h.snapshot().requests.length, 0);
});

test("ordinary Codex MCP elicitations retain the MCP response shape", async function (t) {
  var f = await harness(t);
  f.emit("mcpServer/elicitation/request", { serverName: "example", message: "Name?", mode: "form",
    requestedSchema: { type: "object", properties: { name: { type: "string" } } } }, 43);
  await settle();
  assert.equal(f.h.snapshot().blockedCount, 1);
  var id = Object.keys(f.h.session.pendingElicitations)[0];
  f.h.send({ type: "elicitation_response", requestId: id, action: "accept", content: { name: "Bojan" } });
  await settle(); assert.deepEqual(f.responses, [{ id: 43, result: { action: "accept", content: { name: "Bojan" } } }]);
});

test("answering the normal on-screen Codex question form also returns question answer arrays", async function (t) {
  var f = await harness(t); await f.ask();
  var questionCard = f.h.events.find(function (event) { return event.type === "elicitation_request"; });
  assert.ok(questionCard);
  f.h.send({ type: "elicitation_response", requestId: questionCard.requestId, action: "accept", content: { approach: "Rebuild" } });
  await settle();
  assert.deepEqual(f.responses, [{ id: 42, result: { answers: { approach: { answers: ["Rebuild"] } } } }]);
});

test("Codex server-side resolution, turn completion and close clear the live question and cannot send a late reply", async function (t) {
  for (var method of ["serverRequest/resolved", "turn/completed", "close"]) {
    var f = await harness(t); var request = await f.ask();
    if (method === "close") f.handle.close();
    else f.emit(method, { requestId: 42, turn: { id: "voice-turn", status: "completed", items: [] } });
    await settle();
    assert.equal(f.h.snapshot().requests.length, 0, method);
    assert.equal(f.h.answer(request, { answers: { approach: ["Rebuild"] } }).ok, false);
    await settle(); assert.equal(f.responses.length, 0);
    assert.ok(f.h.events.some(function (event) { return event.type === "elicitation_resolved"; }));
  }
});

test("rejecting Codex questions returns empty answer arrays, never an MCP action", async function (t) {
  var f = await harness(t); var request = await f.ask();
  f.h.send({ type: "elicitation_response", requestId: request.requestId, action: "reject" });
  await settle(); assert.deepEqual(f.responses, [{ id: 42, result: { answers: { approach: { answers: [] } } } }]);
});
