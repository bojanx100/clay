// Tests for the Lead event ledger (CTO orchestrator brick 7).
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var ledger = require("../lib/lead-ledger");

function withDir(fn) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-ledger-"));
  try { fn(dir); } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

function item(id) { return { id: id, title: "t-" + id, project: "clay" }; }
var ROUTE = { vendor: "codex", model: "gpt-5.6-terra", tier: 3 };

test("append assigns monotonic seq and persists across reads", function () {
  withDir(function (dir) {
    var a = ledger.appendEvent({ type: "staffed", item: item("x1"), route: ROUTE, taskId: "t-1" }, { dir: dir, now: 100 });
    var b = ledger.appendEvent({ type: "completed", item: item("x1"), route: ROUTE, evidence: "suite green" }, { dir: dir, now: 200 });
    assert.strictEqual(a.seq, 1);
    assert.strictEqual(b.seq, 2);
    var events = ledger.readEvents({ dir: dir });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].evidence, "suite green");
    assert.strictEqual(events[1].at, 200);
  });
});

test("corrupt tail lines are skipped, never fatal", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("x1"), route: ROUTE }, { dir: dir, now: 1 });
    fs.appendFileSync(path.join(dir, "ledger.jsonl"), '{"type":"completed","item":{"id":"x1"'); // torn write
    var events = ledger.readEvents({ dir: dir });
    assert.strictEqual(events.length, 1);
    // And the ledger keeps working after the torn line
    var next = ledger.appendEvent({ type: "lead_note", note: "recovered" }, { dir: dir, now: 2 });
    assert.strictEqual(next.seq, 2);
  });
});

test("inFlight derives open items; terminal events close them", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE, taskId: "t-a" }, { dir: dir, now: 1 });
    ledger.appendEvent({ type: "staffed", item: item("b"), route: ROUTE, taskId: "t-b" }, { dir: dir, now: 2 });
    ledger.appendEvent({ type: "completed", item: item("a"), route: ROUTE, evidence: "e" }, { dir: dir, now: 3 });
    var open = ledger.inFlight({ dir: dir });
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].item.id, "b");
    assert.strictEqual(open[0].taskId, "t-b");
  });
});

test("re-staffing after failure reopens the item", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE }, { dir: dir, now: 1 });
    ledger.appendEvent({ type: "failed", item: item("a"), route: ROUTE, reason: "suite regressed" }, { dir: dir, now: 2 });
    assert.strictEqual(ledger.inFlight({ dir: dir }).length, 0);
    assert.strictEqual(ledger.failureCount("a", { dir: dir }), 1);
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE }, { dir: dir, now: 3 });
    assert.strictEqual(ledger.inFlight({ dir: dir }).length, 1);
  });
});

test("eventsSinceLastStandup windows correctly", function () {
  withDir(function (dir) {
    ledger.appendEvent({ type: "staffed", item: item("a"), route: ROUTE }, { dir: dir, now: 1 });
    ledger.appendEvent({ type: "standup_composed" }, { dir: dir, now: 2 });
    ledger.appendEvent({ type: "completed", item: item("a"), route: ROUTE, evidence: "e" }, { dir: dir, now: 3 });
    var win = ledger.eventsSinceLastStandup({ dir: dir });
    assert.strictEqual(win.length, 1);
    assert.strictEqual(win[0].type, "completed");
    // A fresh ledger with no marker returns everything
    var all = ledger.readEvents({ dir: dir });
    assert.strictEqual(all.length, 3);
  });
});
