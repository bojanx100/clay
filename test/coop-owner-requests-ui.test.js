var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// The client shapes rows; it never decides what is working, unanswered or
// live. Deriving those on the client is how a finished topic used to keep a
// spinner alive after the server had already called it done.

var MODULE = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "coop-owner-requests.js")).href;

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var COORD = { projectId: CLAY, sessionStorageId: "3046a4dc-2b49-47a8-80dc-1511fb809aba" };
var WORKER = { projectId: CLAY, sessionStorageId: "09ba91a6-130a-4d44-9f10-3de30f7a10ce" };
var TOPIC = { topicId: "auto-a7daa4cc660639337d144d93" };

function overview() {
  return {
    unanswered: [
      { ingressId: "coop:s:182", ingressSequence: 182, topicTitle: "Owner topic execution flow",
        topicRef: TOPIC, requestRef: { eventIndex: 182 }, receivedAt: 5,
        classification: "new_topic", state: "working", attention: null },
      { ingressId: "coop:s:183", ingressSequence: 183, topicTitle: "", topicRef: null,
        requestRef: null, receivedAt: 6, classification: "new_topic",
        state: "attention", attention: "project_target_unavailable" },
    ],
    topics: [{
      topicRef: TOPIC, title: "Owner topic execution flow", status: "open",
      requestCount: 2, unansweredCount: 2, workingCount: 1, needsInputCount: 0, attentionCount: 1,
      projects: [{
        projectRef: { projectId: CLAY },
        coordinator: { sessionRef: COORD, title: "Coordinator", workState: "working", live: true, present: true },
        workers: [{ sessionRef: WORKER, title: "Worker one", workState: "working", live: true }],
      }],
    }],
    counts: { unanswered: 2, topics: 1, working: 2, needsInput: 0, attention: 1 },
  };
}

test("rows flatten topic, project, coordinator and workers in order", async function () {
  var mod = await import(MODULE);
  var rows = mod.ownerRequestRows(overview());

  assert.deepEqual(rows.map(function (r) { return r.kind; }),
    ["topic", "project", "coordinator", "worker"]);
  assert.deepEqual(rows.map(function (r) { return r.depth; }), [0, 1, 2, 3]);
  assert.equal(rows[0].label, "Owner topic execution flow");
  assert.equal(rows[2].label, "Coordinator");
  assert.equal(rows[3].label, "Worker one");
});

test("row counts come straight from the server, never recomputed", async function () {
  var mod = await import(MODULE);
  var rows = mod.ownerRequestRows(overview());

  assert.equal(rows[0].workingCount, 1, "the server said one, even though two sessions are live");
  assert.equal(rows[0].attentionCount, 1);
  assert.equal(rows[0].unansweredCount, 2);
});

test("unanswered rows separate what waits on Coop from what waits on the owner", async function () {
  var mod = await import(MODULE);
  var rows = mod.unansweredRows(overview());

  assert.equal(rows.length, 2);
  assert.equal(rows[0].blockedOnOwner, false);
  assert.equal(rows[1].blockedOnOwner, true);
  assert.equal(rows[1].attention, "project_target_unavailable");
  assert.equal(rows[1].label, "Uncategorised request", "a request with no topic still gets a label");
});

test("an empty overview renders no rows rather than throwing", async function () {
  var mod = await import(MODULE);
  assert.deepEqual(mod.ownerRequestRows({}), []);
  assert.deepEqual(mod.unansweredRows({}), []);
  assert.deepEqual(mod.ownerRequestRows({ topics: [{ topicRef: TOPIC, title: "T" }] }).length, 1);
});

test("a topic with no coordinator yet still renders its project", async function () {
  var mod = await import(MODULE);
  var rows = mod.ownerRequestRows({
    topics: [{ topicRef: TOPIC, title: "T", projects: [{ projectRef: { projectId: CLAY } }] }],
  });
  assert.deepEqual(rows.map(function (r) { return r.kind; }), ["topic", "project"]);
});

test("the handler ignores unrelated messages and keeps a refusal visible", async function () {
  var mod = await import(MODULE);
  assert.equal(mod.handleOwnerRequestOverview({ type: "session_list" }), false);
  assert.equal(mod.handleOwnerRequestOverview(null), false);
  // A refusal must not read as "the owner has nothing outstanding".
  assert.equal(mod.handleOwnerRequestOverview({ type: "coop_owner_requests", ok: false, code: "access_denied" }), true);
  assert.deepEqual(mod.ownerRequestOverview().unanswered, []);
});

test("a successful overview is stored and readable", async function () {
  var mod = await import(MODULE);
  assert.equal(mod.handleOwnerRequestOverview(Object.assign({ type: "coop_owner_requests", ok: true }, overview())), true);
  assert.equal(mod.ownerRequestOverview().counts.unanswered, 2);
  assert.equal(mod.unansweredRows().length, 2);
});
