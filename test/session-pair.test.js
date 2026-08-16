var test = require("node:test");
var assert = require("node:assert");
var pairModule = require("../lib/project-session-pair");

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function fixture(configured) {
  var driver = { localId: 1, ownerId: null, title: "Planner", vendor: "claude", history: [], isProcessing: false };
  var worker = { localId: 2, ownerId: null, title: "Builder", vendor: "codex", history: [], isProcessing: false };
  var sessions = new Map([[1, driver], [2, worker]]);
  var group = { id: "sg_pair", members: [1, 2] };
  if (configured) group.pair = { driverId: 1, workerId: 2 };
  var events = [];
  var starts = [];
  var sm = {
    sessions: sessions,
    installedVendors: ["claude", "codex"],
    modelsByVendor: {},
    capabilitiesByVendor: {},
    sendAndRecord: function (session, message) { session.history.push(message); },
    sendToSession: function () {},
    broadcastSessionList: function () {},
  };
  var sdk = {
    pushMessage: function () { return false; },
    startQuery: function (session, text) {
      starts.push({ session: session, text: text });
      setTimeout(function () {
        session.history.push({ type: "delta", text: "Partner result" });
        session.isProcessing = false;
      }, 20);
      return Promise.resolve();
    },
  };
  var attached = pairModule.attachSessionPair({
    sm: sm,
    splitStore: { groupForMember: function (id) { return group.members.indexOf(id) === -1 ? null : group; }, create: function () {} },
    getSdk: function () { return sdk; },
    send: function (message) { events.push(message); },
    sendTo: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    getLinuxUserForSession: function () { return null; },
    onProcessingChanged: function () {},
  });
  return { attached: attached, driver: driver, worker: worker, events: events, starts: starts };
}

test("configured pairs expose partner tools only to the Driver", function () {
  var f = fixture(true);
  assert.deepStrictEqual(f.attached.getToolDefs(f.driver).map(function (tool) { return tool.name; }), ["send_to_partner", "read_partner"]);
  assert.deepStrictEqual(f.attached.getToolDefs(f.worker), []);
  assert.match(f.attached.getSystemPrompt(f.driver), /Driver/);
  assert.strictEqual(f.attached.getSystemPrompt(f.worker), "");
});

test("ad-hoc splits expose partner tools to both sessions", function () {
  var f = fixture(false);
  assert.strictEqual(f.attached.getToolDefs(f.driver).length, 2);
  assert.strictEqual(f.attached.getToolDefs(f.worker).length, 2);
});

test("send_to_partner records attribution and returns the response", async function () {
  var f = fixture(true);
  var tool = f.attached.getToolDefs(f.driver)[0];
  var result = parseToolResult(await tool.handler({ message: "Inspect the tests", timeoutSeconds: 2 }));
  assert.deepStrictEqual(result, { status: "complete", response: "Partner result" });
  assert.strictEqual(f.worker.history[0].delegated, true);
  assert.strictEqual(f.worker.history[0].delegatedBy, 1);
  assert.strictEqual(f.worker.history[0].delegatedByTitle, "Planner");
  assert.strictEqual(f.starts[0].text, "Inspect the tests");
  assert.deepStrictEqual(f.events.map(function (event) { return event.active; }), [true, false]);
  assert.strictEqual(f.worker._delegatedBy, undefined);
});

test("a delegated session cannot delegate back", async function () {
  var f = fixture(false);
  f.worker._delegatedBy = 1;
  var tool = f.attached.getToolDefs(f.worker)[0];
  var result = await tool.handler({ message: "Send this back" });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /cannot delegate/);
});

test("recentTurns returns user-delimited partner turns with capped selection", function () {
  var session = { history: [
    { type: "user_message", text: "First" }, { type: "delta", text: "One" },
    { type: "user_message", text: "Second", delegated: true }, { type: "delta", text: "Two" },
  ] };
  assert.deepStrictEqual(pairModule.recentTurns(session, 1), [{ user: "Second", delegated: true, response: "Two" }]);
});
