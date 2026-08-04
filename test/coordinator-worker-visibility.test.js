var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function worker(id, status, lastActivity, active) {
  return {
    id: id,
    active: !!active,
    lastActivity: lastActivity,
    orchestrationParent: { taskStatus: status }
  };
}

test("collapsed coordinator workers show at most three current workers", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "running", 10),
    worker(2, "ready", 20),
    worker(3, "queued", 30),
    worker(4, "running", 40),
    worker(5, "completed", 50)
  ], 99, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [4, 3, 2]);
  assert.equal(display.hiddenActive, 1);
  assert.equal(display.hiddenResolved, 1);
});

test("collapsed coordinator workers show recent resolved work when none are current", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "completed", 10),
    worker(2, "dismissed", 20),
    worker(3, "completed", 30),
    worker(4, "completed", 40),
    worker(5, "completed", 50)
  ], 100, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [5, 4, 3]);
  assert.equal(display.hiddenActive, 0);
  assert.equal(display.hiddenResolved, 2);
});

test("a selected resolved session does not outrank current work", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "completed", 50, true),
    worker(2, "running", 10)
  ], 103, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [2]);
  assert.equal(display.hiddenResolved, 1);
});

test("attention states appear before ordinary active work", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "running", 50),
    worker(2, "needs_input", 10),
    worker(3, "blocked", 20)
  ], 101, false);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [3, 2, 1]);
});

test("forced expansion returns active and resolved workers", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coordinator-workers.js");
  var workers = await import(pathToFileURL(modulePath).href);
  var display = workers.coordinatorWorkerDisplay([
    worker(1, "completed", 30),
    worker(2, "running", 20),
    worker(3, "dismissed", 10)
  ], 102, true);

  assert.deepEqual(display.workers.map(function (session) { return session.id; }), [2, 1, 3]);
  assert.equal(display.expanded, true);
  assert.equal(display.hiddenCount, 0);
});
