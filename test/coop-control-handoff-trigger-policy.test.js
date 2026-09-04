// The Class B handoff trigger's policy split: thresholds are data, authority is
// code. These tests drive the real normalizer against files that try to widen
// authority, and assert the file loses every time.

var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var handoffModule = require("../lib/coop-control-handoff");
var trigger = require("../lib/coop-control-handoff-trigger");

function tempFile() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-handoff-policy-"));
  return { dir: dir, file: path.join(dir, "coop-handoff-trigger-policy.json"),
    cleanup: function () { fs.rmSync(dir, { recursive: true, force: true }); } };
}

function liveObservation(overrides) {
  return Object.assign({
    alreadyHandedOff: false, controlPresent: true, idleMs: 7200000,
    initiator: "daemon", isProcessing: false, status: "running",
    sessionRef: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e",
      sessionStorageId: "predecessor-1" },
  }, overrides || {});
}

function policyWith(conditions) {
  return { schema: trigger.SCHEMA, version: trigger.VERSION, conditions: conditions };
}

function condition(overrides) {
  var base = null;
  for (var i = 0; i < trigger.DEFAULT_CONDITIONS.length; i++) {
    if (trigger.DEFAULT_CONDITIONS[i].conditionId === "runtime_dead_work_wanted") {
      base = trigger.DEFAULT_CONDITIONS[i];
    }
  }
  return Object.assign(JSON.parse(JSON.stringify(base)), overrides || {});
}

// --------------------------------------------------------------------------
// The data half really is adjustable.
// --------------------------------------------------------------------------

test("a threshold raised in the policy file stops the condition matching", function () {
  var matched = trigger.decide(policyWith([condition({ enabled: true, minIdleMs: 3600000 })]),
    liveObservation({ idleMs: 7200000 }));
  assert.equal(matched.ok, true);
  assert.equal(matched.conditionId, "runtime_dead_work_wanted");
  assert.equal(matched.controllerReason, "wedged_thread");

  var raised = trigger.decide(policyWith([condition({ enabled: true, minIdleMs: 86400000 })]),
    liveObservation({ idleMs: 7200000 }));
  assert.equal(raised.ok, false);
  assert.equal(raised.code, "handoff_trigger_no_condition_matched");
});

test("a condition disabled in the policy file never fires", function () {
  var decision = trigger.decide(policyWith([condition({ enabled: false })]), liveObservation());
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "handoff_trigger_no_condition_matched");
});

test("the default policy round-trips through the readable copy on disk", function () {
  var tmp = tempFile();
  try {
    var store = trigger.createTriggerPolicyStore({ file: tmp.file });
    var published = store.publishDefaults();
    assert.equal(published.ok, true);
    var reloaded = store.load();
    assert.equal(reloaded.ok, true);
    assert.deepStrictEqual(reloaded.policy, published.policy);
    // The file is a readable copy, not an opaque blob.
    var raw = JSON.parse(fs.readFileSync(tmp.file, "utf8"));
    assert.equal(raw.schema, trigger.SCHEMA);
    assert.ok(raw.conditions.length >= 5);
    for (var i = 0; i < raw.conditions.length; i++) {
      assert.ok(raw.conditions[i].note, "every condition must carry its rationale");
      assert.ok(raw.conditions[i].producer, "every condition must name its evidence producer");
    }
  } finally { tmp.cleanup(); }
});

test("a missing policy file falls back to the code defaults rather than failing open", function () {
  var tmp = tempFile();
  try {
    var loaded = trigger.createTriggerPolicyStore({ file: tmp.file }).load();
    assert.equal(loaded.ok, true);
    assert.deepStrictEqual(loaded.policy, trigger.defaultPolicy());
  } finally { tmp.cleanup(); }
});

test("an unreadable or malformed policy file declines instead of defaulting", function () {
  var tmp = tempFile();
  try {
    fs.writeFileSync(tmp.file, "{ not json");
    var store = trigger.createTriggerPolicyStore({ file: tmp.file });
    assert.equal(store.load().code, "handoff_trigger_policy_unreadable");
    fs.writeFileSync(tmp.file, JSON.stringify({ schema: "wrong", version: 1, conditions: [] }));
    assert.equal(store.load().code, "handoff_trigger_policy_malformed");
  } finally { tmp.cleanup(); }
});

// --------------------------------------------------------------------------
// The authority half is not adjustable. Each of these is a file trying to
// widen authority and losing.
// --------------------------------------------------------------------------

test("the policy file cannot make a worker the initiator", function () {
  var normalized = trigger.normalizePolicy(policyWith([condition({ initiator: "worker" })]));
  assert.deepStrictEqual(normalized.conditions, [],
    "a file naming 'worker' as initiator must be dropped, not honoured");
  // And even a well-formed policy cannot be reached by a worker.
  var decision = trigger.decide(policyWith([condition({ enabled: true })]),
    liveObservation({ initiator: "worker" }));
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "handoff_trigger_worker_may_not_initiate");
});

test("worker is absent from the initiator set in code", function () {
  assert.equal(trigger.INITIATORS.worker, undefined);
  assert.equal(trigger.INITIATORS.daemon, true);
  assert.equal(trigger.INITIATORS.coordinator, true);
  assert.equal(trigger.INITIATORS.owner, true);
});

test("the policy file cannot change a condition's controller reason", function () {
  var normalized = trigger.normalizePolicy(policyWith([
    condition({ controllerReason: "owner_stuck" })]));
  assert.deepStrictEqual(normalized.conditions, []);
});

test("the policy file cannot enable a permanently gated condition", function () {
  for (var i = 0; i < trigger.PERMANENTLY_GATED.length; i++) {
    var gated = trigger.PERMANENTLY_GATED[i];
    assert.equal(trigger.isPermanentlyGated(gated), true);
    var normalized = trigger.normalizePolicy(policyWith([
      { conditionId: gated, controllerReason: "wedged_thread", initiator: "daemon",
        enabled: true, minIdleMs: 0, minFailures: 0 }]));
    assert.deepStrictEqual(normalized.conditions, [],
      gated + " is permanently gated and must never survive normalization");
  }
});

test("the policy file cannot invent a condition", function () {
  var normalized = trigger.normalizePolicy(policyWith([
    { conditionId: "hand_off_everything", controllerReason: "wedged_thread",
      initiator: "daemon", enabled: true, minIdleMs: 0, minFailures: 0 }]));
  assert.deepStrictEqual(normalized.conditions, [],
    "a condition with no predicate in code must be dropped");
});

test("every shipped condition names a reason the handoff controller actually accepts", function () {
  // Cross-checked against the real controller vocabulary, not a copy of it.
  // coop-control-recovery-schema.js pins the same seven in a SQL CHECK.
  for (var i = 0; i < trigger.DEFAULT_CONDITIONS.length; i++) {
    var item = trigger.DEFAULT_CONDITIONS[i];
    assert.equal(handoffModule.REASONS[item.controllerReason], true,
      item.conditionId + " names reason '" + item.controllerReason +
      "' which the handoff controller would reject");
    assert.equal(trigger.INITIATORS[item.initiator], true,
      item.conditionId + " names an illegal initiator");
    assert.equal(trigger.isPermanentlyGated(item.conditionId), false);
  }
});

test("the trigger can only ever produce a Class B handoff", function () {
  assert.equal(trigger.TRIGGER_CLASS, "B");
  var decision = trigger.decide(policyWith([condition({ enabled: true })]), liveObservation());
  assert.equal(decision.handoffClass, "B");
});

// --------------------------------------------------------------------------
// Gates that hold for every condition regardless of the file.
// --------------------------------------------------------------------------

test("a terminal execution can never be handed off", function () {
  var terminal = ["completed", "failed", "cancelled", "superseded"];
  for (var i = 0; i < terminal.length; i++) {
    var decision = trigger.decide(policyWith([condition({ enabled: true })]),
      liveObservation({ status: terminal[i] }));
    assert.equal(decision.ok, false, terminal[i] + " must be refused");
    assert.equal(decision.code, "handoff_trigger_terminal_execution");
  }
});

test("an execution blocked on the owner is never handed off", function () {
  var blocked = ["needs_input", "waiting_user"];
  for (var i = 0; i < blocked.length; i++) {
    var decision = trigger.decide(policyWith([condition({ enabled: true })]),
      liveObservation({ status: blocked[i] }));
    assert.equal(decision.ok, false);
    assert.equal(decision.code, "handoff_trigger_owner_input_pending");
  }
});

test("an uncontrolled execution is never handed off", function () {
  var decision = trigger.decide(policyWith([condition({ enabled: true })]),
    liveObservation({ controlPresent: false }));
  assert.equal(decision.code, "handoff_trigger_uncontrolled_execution");
});

test("an execution already handed off is never handed off again", function () {
  var decision = trigger.decide(policyWith([condition({ enabled: true })]),
    liveObservation({ alreadyHandedOff: true }));
  assert.equal(decision.code, "handoff_trigger_already_handed_off");
});

test("a processing execution is not judged idle", function () {
  var decision = trigger.decide(policyWith([condition({ enabled: true, minIdleMs: 1 })]),
    liveObservation({ isProcessing: true }));
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "handoff_trigger_no_condition_matched");
});

// --------------------------------------------------------------------------
// The reaper seam.
// --------------------------------------------------------------------------

test("a reaper verdict overrides the idle fallback in both directions", function () {
  var policy = policyWith([condition({ enabled: true, minIdleMs: 86400000 })]);
  // Idle threshold not met, but the reaper says dead and the work is wanted.
  var honoured = trigger.decide(policy, liveObservation({ idleMs: 1000,
    reaperVerdict: { dead: true, workWanted: true } }));
  assert.equal(honoured.ok, true);
  assert.equal(honoured.controllerReason, "wedged_thread");
  // Idle threshold met, but the reaper says the work is finished with. The
  // reaper's verdict wins: the trigger does not second-guess it.
  var refused = trigger.decide(policyWith([condition({ enabled: true, minIdleMs: 1 })]),
    liveObservation({ idleMs: 99999999, reaperVerdict: { dead: true, workWanted: false } }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "handoff_trigger_no_condition_matched");
  var alive = trigger.decide(policyWith([condition({ enabled: true, minIdleMs: 1 })]),
    liveObservation({ idleMs: 99999999, reaperVerdict: { dead: false, workWanted: true } }));
  assert.equal(alive.ok, false);
});

// --------------------------------------------------------------------------
// The master switch.
// --------------------------------------------------------------------------

test("the trigger is off unless its own switch and the kernel flags are both set", function () {
  var kernel = { CLAY_COOP_CONTROL_STORE: "1", CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1" };
  assert.equal(trigger.isHandoffTriggerEnabled({ env: {} }), false);
  assert.equal(trigger.isHandoffTriggerEnabled({ env: kernel }), false,
    "the kernel being live must not by itself enable the trigger");
  assert.equal(trigger.isHandoffTriggerEnabled({
    env: { CLAY_COOP_HANDOFF_TRIGGER: "1" } }), false,
    "the trigger switch must not work while the control kernel is dark");
  assert.equal(trigger.isHandoffTriggerEnabled({
    env: Object.assign({ CLAY_COOP_HANDOFF_TRIGGER: "1" }, kernel) }), true);
  assert.equal(trigger.isHandoffTriggerEnabled({
    env: Object.assign({ CLAY_COOP_HANDOFF_TRIGGER: "0" }, kernel) }), false);
});

test("a disabled trigger's sweep evaluates nothing", function () {
  var created = trigger.createHandoffTrigger({ env: {} });
  assert.equal(created.enabled, false);
  var result = created.sweep({ observe: function () {
    throw new Error("a disabled trigger must not even build observations");
  } });
  assert.equal(result.enabled, false);
  assert.deepStrictEqual(result.fired, []);
});

test("the shipped default has the master switch name the owner can grep for", function () {
  assert.equal(trigger.TRIGGER_ENV, "CLAY_COOP_HANDOFF_TRIGGER");
  assert.equal(trigger.MAX_FIRES_PER_SWEEP, 1);
});
