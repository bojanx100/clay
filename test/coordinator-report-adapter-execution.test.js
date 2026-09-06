var test = require("node:test");
var assert = require("node:assert/strict");
var fixture = require("./helpers/coordinator-report-fixture").fixture;
var settled = require("./helpers/coordinator-report-fixture").settled;
var claude = require("../lib/yoke/adapters/claude").contractTestKit;
var codex = require("../lib/yoke/adapters/codex").contractTestKit;
var copilot = require("../lib/yoke/adapters/github-copilot")._test;

function claudeHandle() {
  return claude.createQueryHandle({ close: function () {},
    [Symbol.asyncIterator]: function () { return { next: async function () { return { done: true }; } }; },
  }, claude.createMessageQueue(), new AbortController());
}

function codexHandle() {
  return codex.createQueryHandle({ started: true, send: async function () { return {}; },
    notify: function () {}, respond: function () {} }, { cwd: process.cwd(), model: "gpt-5.6-terra",
    abortController: new AbortController() });
}

[{ name: "Claude", create: claudeHandle }, { name: "Codex", create: codexHandle },
  { name: "Copilot", create: function () { return copilot.createCopilotQueryHandle({}); } }].forEach(function (vendor) {
  (vendor.name === "Copilot" ? ["close"] : ["close", "endInput"]).forEach(function (end) {
    test(vendor.name + " " + end + " refuses a real coordinator report without acknowledging its durable queue", function (t) {
      var handle = vendor.create();
      handle[end]();
      var f = fixture(t);
      f.session.queryInstance = handle;
      assert.equal(f.deliver().ok, true);
      assert.equal(f.session.pendingCoordinatorUpdates.length, 1);
      assert.equal(f.session.pendingCoordinatorUpdates[0].state, "pending");
      assert.equal(handle.pushMessage("Another report"), false);
      handle.close();
    });
  });
});

test("Claude rejects input after its raw output stream has ended", async function () {
  var handle = claudeHandle();
  assert.equal((await handle[Symbol.asyncIterator]().next()).done, true);
  assert.equal(handle.pushMessage("Undeliverable report"), false);
});

test("a rejected closed query is retired so the next retry can start a usable provider", async function (t) {
  var f = fixture(t);
  var handle = codexHandle();
  handle.endInput();
  f.session.queryInstance = handle;
  f.deliver();
  assert.equal(f.session.queryInstance, null);
  assert.equal(f.session.pendingCoordinatorUpdates.length, 1);
  f.now += 60001;
  f.router.retryCoordinatorUpdates();
  await settled();
  assert.equal(f.starts, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal(f.session.pendingCoordinatorUpdates.length, 0);
});

test("Claude worker input closure and worker exit both refuse reports", function () {
  var callback;
  var sent = [];
  var worker = { send: function (message) { sent.push(message); return true; },
    onMessage: function (fn) { callback = fn; } };
  var handle = claude.createWorkerQueryHandle(worker);
  assert.equal(handle.pushMessage("First report"), true);
  handle.endInput();
  assert.equal(handle.pushMessage("Too late"), false);
  var other = claude.createWorkerQueryHandle(worker);
  callback({ type: "query_done" });
  assert.equal(other.pushMessage("After exit"), false);
  assert.equal(sent.filter(function (message) { return message.type === "push_message"; }).length, 1);
});
