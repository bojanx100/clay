// Guards the Class B recoverable handoff trigger's caller.
//
// The Coop control kernel's Class B handoff shipped complete and dark: the
// controller in lib/coop-control-handoff.js and the production adapter in
// lib/coop-control-handoff-target.js were both correct and both reachable, and
// for eight days nothing called them. The live store showed it -- 45 handoff
// rows, every one a Class A "handoff:restart:" supersession, zero cutovers,
// zero Class B rows, zero successor receipts.
//
// Every unit test in this repo still passed throughout, because they all
// construct the controls directly. That is the failure mode these assertions
// exist for, so they check that the trigger's call site is REACHED, not merely
// that the trigger is exported. The behavioural test below is the real guard:
// delete the sweepHandoffTriggers() call from ensureControlPlane and it fails,
// because it drives the same entry point production drives and observes the
// durable cutover and receipt in SQLite.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var controlPlane = require("../lib/coop-control-plane");
var executions = require("../lib/coop-control-executions");
var handoffTarget = require("../lib/coop-control-handoff-target");
var handoffTrigger = require("../lib/coop-control-handoff-trigger");
var handoffs = require("../lib/coop-control-handoff");
var projectIdentity = require("../lib/project-identity");
var storeModule = require("../lib/coop-control-store");

var CONTROL_PLANE_PATH = path.join(__dirname, "..", "lib", "coop-control-plane.js");
var EXTERNAL_PATH = path.join(__dirname, "..", "lib", "project-task-orchestrator-external.js");

var PROJECT = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var SOURCE = { projectId: "system-lead", sessionStorageId: "871a194b-8879-40f7-a1fe-656e48e722af" };
var PREDECESSOR_ID = "predecessor-session-0001";
var TASK_ID = "clay-classb-wiring";
var REVISION = 1;

function availableTest(name, fn) {
  test(name, { skip: !storeModule.isControlStoreAvailable() }, fn);
}

// --------------------------------------------------------------------------
// Source-shape guards. Cheap, and they name the exact line that must survive.
// --------------------------------------------------------------------------

test("ensureControlPlane calls the Class B handoff trigger sweep per project", function () {
  var source = fs.readFileSync(CONTROL_PLANE_PATH, "utf8");
  assert.match(source, /require\(\s*["']\.\/coop-control-handoff-sweep["']\s*\)/,
    "lib/coop-control-plane.js must require ./coop-control-handoff-sweep; without it the " +
    "Class B trigger has no production caller at all.");
  assert.match(source, /handoffs\.push\(\s*handoffSweep\.sweepHandoffTriggers\(/,
    "ensureControlPlane must call sweepHandoffTriggers(...) inside its per-project loop. " +
    "That loop is the trigger's only production call site: it runs on every owner-facing " +
    "Coop projection build (lib/server.js globalCoopProjectionFor). Remove the call and the " +
    "trigger goes dark exactly the way the handoff controller did, with every unit test " +
    "still green.");
});

test("the external portfolio target stamps the handoff adapter for the Lead-side sweep", function () {
  var source = fs.readFileSync(EXTERNAL_PATH, "utf8");
  assert.match(source, /sm\.coopControlHandoffAdapter\s*=\s*handoffAdapter\s*;/,
    "lib/project-task-orchestrator-external.js must stamp sm.coopControlHandoffAdapter inside " +
    "its recoveryDelivery.enabled block. The Lead-side trigger sweep holds the target " +
    "SessionManager but not this closure, so without the stamp every sweep declines with " +
    "handoff_adapter_unavailable and no handoff can ever fire.");
  // It has to be inside the enabled block, next to the other three stamps --
  // stamping it unconditionally would hand the sweep an adapter that throws.
  var enabledBlock = source.slice(source.indexOf("if (recoveryDelivery.enabled) {"));
  assert.ok(enabledBlock.indexOf("sm.coopControlHandoffAdapter") !== -1 &&
    enabledBlock.indexOf("sm.coopControlHandoffAdapter") < enabledBlock.indexOf("} else {"),
    "sm.coopControlHandoffAdapter must be stamped inside the recoveryDelivery.enabled branch.");
});

test("new control modules stay text-only and below the project module limit", function () {
  var files = [
    "coop-control-plane.js",
    "coop-control-handoff-sweep.js",
    "coop-control-handoff-trigger.js",
    "coop-execution-reaper.js",
    "coop-execution-reaper-runtime.js",
    "project-task-orchestrator-external.js",
  ];
  for (var i = 0; i < files.length; i++) {
    var body = fs.readFileSync(path.join(__dirname, "..", "lib", files[i]));
    assert.equal(body.indexOf(0), -1, files[i] + " contains a NUL byte");
    assert.ok(body.toString("utf8").split("\n").length - 1 < 500,
      files[i] + " must stay below 500 lines");
  }
});

// --------------------------------------------------------------------------
// The behavioural guard. Real store, real execution, real adapter, real
// ensureControlPlane. This is what fails when the caller disappears.
// --------------------------------------------------------------------------

function manager(projectId) {
  var sessions = new Map();
  var api = {
    sessions: sessions, appended: [], broadcasts: 0, saves: 0,
    getProjectId: function () { return projectId; },
    createSessionRaw: function (options) {
      var session = Object.assign({ localId: sessions.size + 1, history: [],
        orchestrationPolicy: {} }, options);
      sessions.set(session.localId, session);
      return session;
    },
    saveSessionFile: function () { api.saves += 1; },
    appendToSessionFile: function (session, item) { api.appended.push(item); },
    broadcastSessionList: function () { api.broadcasts += 1; },
  };
  return api;
}

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-handoff-trigger-"));
  var dbPath = path.join(dir, "coop-control.sqlite");
  var store = storeModule.openControlStore({ dbPath: dbPath });
  var control = executions.createExecutionControl({ enabled: true, store: store });
  var handoffControl = handoffs.createHandoffControl({ enabled: true, store: store,
    executionControl: control });
  var predecessorRef = { projectId: PROJECT, sessionStorageId: PREDECESSOR_ID };
  var token = control.reserveStart({ portfolioTaskId: TASK_ID, bindingRevision: REVISION,
    idempotencyKey: TASK_ID + ":r1", mode: "project_coordinator",
    targetProject: { projectId: PROJECT }, source: SOURCE });
  control.bindStart(token, predecessorRef);
  control.openStartBarrier(token);
  control.markProviderStarted(token);

  var binding = { portfolioTaskId: TASK_ID, bindingRevision: REVISION,
    targetProject: { projectId: PROJECT }, mode: "project_coordinator", status: "active" };
  var leadManager = manager("system-lead");
  var targetManager = manager(PROJECT);
  leadManager.createSessionRaw({ storageId: SOURCE.sessionStorageId, coopHome: true });

  // A live controlled execution that has not moved for four hours and is not
  // processing. The trigger derives the condition from this state; the verdict
  // is never handed to it.
  var predecessor = targetManager.createSessionRaw({ storageId: PREDECESSOR_ID });
  predecessor.isProcessing = false;
  predecessor.orchestrationPolicy.portfolioExecution = {
    portfolioTaskId: TASK_ID, bindingRevision: REVISION, idempotencyKey: TASK_ID + ":r1",
    mode: "project_coordinator", status: "running", source: SOURCE,
    targetProject: { projectId: PROJECT }, createdAt: Date.now() - 14400000,
    updatedAt: Date.now() - 14400000, control: { executionId: token.executionId },
  };
  targetManager.coopControlHandoffAdapter = function () {
    return handoffTarget.createProductionHandoffAdapter({
      canonicalBinding: function (taskId, revision) {
        return taskId === TASK_ID && Number(revision) === REVISION ? binding : null;
      },
      executionControl: control,
      executionMetadata: function (session) {
        return session && session.orchestrationPolicy &&
          session.orchestrationPolicy.portfolioExecution;
      },
      handlers: { rehydrate: function () { return true; },
        activate: function (record, successorToken) {
          control.markProviderStarted(successorToken);
          return true;
        } },
      handoffControl: handoffControl, projectId: function () { return PROJECT; },
      sm: targetManager,
    });
  };

  var coordinator = leadManager.createSessionRaw({ storageId: "lead-coordinator-0001",
    coordinationMode: true });
  coordinator.coordinationRole = "project_coordinator";
  coordinator.orchestrationEvents = [];
  coordinator.orchestrationTasks = [{ taskId: "task-" + TASK_ID,
    clientRef: "portfolio:" + TASK_ID + ":" + REVISION, title: "Class B wiring",
    objective: "Drive a real Class B handoff.", status: "running" }];
  coordinator.orchestrationPolicy.coopControlPlane = { version: 1,
    role: "project_coordinator", projectRef: { projectId: PROJECT }, createdAt: Date.now() };

  var policyFile = path.join(dir, "coop-handoff-trigger-policy.json");
  var policyStore = handoffTrigger.createTriggerPolicyStore({ file: policyFile });
  policyStore.publishDefaults();

  return {
    coordinator: coordinator, control: control, dbPath: dbPath, leadManager: leadManager,
    policyFile: policyFile, policyStore: policyStore, predecessor: predecessor,
    targetManager: targetManager, token: token,
    ensure: function (options) {
      var opts = options || {};
      return controlPlane.ensureControlPlane(leadManager, [{
        projectRef: { projectId: PROJECT }, title: "Wiring", manager: targetManager,
        handoffTrigger: opts.trigger || handoffTrigger.createHandoffTrigger({
          enabled: true, policyStore: policyStore }),
      }]);
    },
    cleanup: function () {
      try { handoffControl.close(); } catch (error) {}
      try { control.close(); } catch (error) {}
      try { store.close(); } catch (error) {}
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Every behavioural test goes through this, so losing the call site produces
// one legible failure instead of a TypeError on undefined.
function sweepOf(result) {
  assert.ok(Array.isArray(result && result.handoffs) && result.handoffs.length === 1,
    "ensureControlPlane returned no handoff sweep result for the project. The " +
    "sweepHandoffTriggers(...) call is missing from its per-project loop, which is the " +
    "Class B trigger's only production call site.");
  return result.handoffs[0];
}

function classBRow(dbPath) {
  var sqlite = require("node:sqlite");
  var db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  var row = db.prepare("SELECT * FROM coop_control_handoffs WHERE handoff_class = 'B'").get();
  var receipt = row ? db.prepare("SELECT * FROM coop_control_successor_receipts " +
    "WHERE handoff_id = ?").get(row.handoff_id) : null;
  db.close();
  return { receipt: receipt, row: row };
}

availableTest("the control-plane sweep drives a real Class B handoff to a durable cutover and receipt",
  function () {
    var h = harness();
    try {
      var result = h.ensure();
      assert.equal(result.ok, true);
      var sweep = sweepOf(result);
      assert.equal(sweep.enabled, true, "the trigger must be enabled in this harness");
      assert.equal(sweep.fired.length, 1,
        "ensureControlPlane did not fire a Class B handoff. If sweepHandoffTriggers() was " +
        "removed from the per-project loop, this is what it looks like: declined=" +
        JSON.stringify(sweep.declined));

      // Durable truth, read back out of SQLite rather than trusting the return.
      var durable = classBRow(h.dbPath);
      assert.ok(durable.row, "no Class B row in coop_control_handoffs");
      assert.equal(durable.row.handoff_class, "B");
      assert.equal(durable.row.reason, "wedged_thread");
      assert.equal(durable.row.state, "completed");
      assert.equal(durable.row.successor_state, "created");
      assert.ok(durable.row.cutover_at, "cutover_at is null, so no cutover happened");
      assert.ok(durable.row.completed_at, "completed_at is null");
      assert.equal(durable.row.from_session_id, PREDECESSOR_ID);
      assert.notEqual(durable.row.to_session_id, PREDECESSOR_ID);
      assert.ok(durable.receipt, "no successor receipt row");
      assert.equal(durable.receipt.receipt_id, durable.row.successor_receipt_id);
      assert.equal(durable.receipt.session_storage_id, durable.row.to_session_id);

      // The successor SessionRef is a real session in the target manager.
      var successor = null;
      h.targetManager.sessions.forEach(function (session) {
        if (projectIdentity.sessionStorageId(session) === durable.row.to_session_id) {
          successor = session;
        }
      });
      assert.ok(successor, "the successor SessionRef was never retained by the SessionManager");
    } finally { h.cleanup(); }
  });

availableTest("a fired handoff is visible to the owner on the project coordinator", function () {
  var h = harness();
  try {
    h.ensure();
    var notice = h.coordinator.history.filter(function (item) {
      return item && item.type === "system_info" && item.coopHandoff;
    })[0];
    // system_info is the only mechanism that puts a durable, visible line in the
    // owner's own conversation view. orchestrationEvents is never projected to
    // the browser, so an event-only surfacing would be invisible.
    assert.ok(notice, "no system_info handoff notice in the coordinator transcript");
    assert.match(notice.text, /Class B handoff fired/);
    assert.match(notice.text, /runtime_dead_work_wanted/);
    assert.match(notice.text, /wedged_thread/);
    assert.match(notice.text, new RegExp(PREDECESSOR_ID));
    assert.ok(notice.text.indexOf(notice.coopHandoff.successor.sessionStorageId) !== -1,
      "the notice must name the successor now carrying the work");
    assert.ok(notice.text.indexOf(notice.coopHandoff.receiptId) !== -1,
      "the notice must name the successor receipt");
    assert.ok(h.leadManager.appended.indexOf(notice) !== -1,
      "the notice must be persisted through appendToSessionFile, or it does not survive replay");
    assert.ok(h.leadManager.broadcasts > 0, "the Lead session list must be rebroadcast");

    var event = h.coordinator.orchestrationEvents.filter(function (item) {
      return item && item.type === "execution_handed_off";
    })[0];
    assert.ok(event, "no execution_handed_off orchestration event for the durable record");
    assert.equal(event.data.conditionId, "runtime_dead_work_wanted");

    var task = h.coordinator.orchestrationTasks[0];
    assert.match(task.currentActivity, /^Handed off to /);

    var metadata = h.predecessor.orchestrationPolicy.portfolioExecution;
    assert.equal(metadata.status, "superseded");
    assert.equal(metadata.statusReason, "coop_class_b_handoff");
    assert.ok(metadata.coopHandoff.handoffId);
    assert.ok(metadata.coopHandoff.receiptId);
  } finally { h.cleanup(); }
});

availableTest("the sweep never hands the same execution off twice", function () {
  var h = harness();
  try {
    assert.equal(sweepOf(h.ensure()).fired.length, 1);
    var again = sweepOf(h.ensure());
    assert.equal(again.fired.length, 0,
      "the trigger fired a second handoff for an execution it had already moved");
  } finally { h.cleanup(); }
});

availableTest("the sweep is inert while the master switch is off", function () {
  var h = harness();
  try {
    var off = handoffTrigger.createHandoffTrigger({ env: {}, policyStore: h.policyStore });
    var sweep = sweepOf(h.ensure({ trigger: off }));
    assert.equal(sweep.enabled, false);
    assert.equal(sweep.fired.length, 0);
    assert.equal(classBRow(h.dbPath).row, undefined,
      "a disabled trigger must not touch the durable handoff table");
    assert.equal(h.predecessor.orchestrationPolicy.portfolioExecution.status, "running");
  } finally { h.cleanup(); }
});

availableTest("the sweep declines when the target manager carries no handoff adapter", function () {
  var h = harness();
  try {
    delete h.targetManager.coopControlHandoffAdapter;
    var sweep = sweepOf(h.ensure());
    assert.equal(sweep.ok, false);
    assert.equal(sweep.code, "handoff_adapter_unavailable");
    assert.equal(classBRow(h.dbPath).row, undefined);
  } finally { h.cleanup(); }
});
