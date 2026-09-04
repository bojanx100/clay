var test = require("node:test");
var assert = require("node:assert/strict");
var visibility = require("../lib/coop-session-visibility");

function project(manager) {
  return { sm: manager };
}

function session(extra) {
  return Object.assign({
    localId: 7,
    hidden: false,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "canonical-coop", since: 1 },
  }, extra || {});
}

test("only an explicitly archived dismissed Coop task coordinator is hidden durably", function () {
  var hidden = session({});
  var calls = [];
  var manager = {
    hideSession: function (localId, ws, options) {
      calls.push([localId, ws, options]);
      hidden.hidden = true;
    },
  };
  assert.equal(visibility.hideDismissedSession(project(manager), hidden,
    { taskId: "dismissed", status: "dismissed", archivedAt: 1 }), true);
  assert.equal(hidden.hidden, true);
  // cascadeWorkers is part of the contract, not incidental: a dismissed,
  // archived coordinator's workers are finished by construction and must be
  // hidden with it, or they leak into the sidebar and the mobile Projects picker.
  // See test/coop-dismissed-worker-visibility.test.js, which drives the real
  // sessions-deletion module rather than the stub below.
  assert.deepEqual(calls,
    [[7, null, { projectionOnly: true, cascadeWorkers: true }]]);
});

test("ordinary dismissal, owner-direct, active, attention, and already hidden sessions stay untouched", function () {
  var calls = 0;
  var manager = { hideSession: function () { calls++; } };
  var cases = [
    session(),
    session({ coopControlledBy: null }),
    session({ coordinationRole: "project_coordinator" }),
    session({ hidden: true }),
  ];
  for (var i = 0; i < cases.length; i++) {
    assert.equal(visibility.hideDismissedSession(project(manager), cases[i],
      { taskId: "dismissed", status: "dismissed" }), false);
  }
  assert.equal(visibility.hideDismissedSession(project(manager), session(),
    { taskId: "active", status: "running" }), false);
  assert.equal(calls, 0);
});
