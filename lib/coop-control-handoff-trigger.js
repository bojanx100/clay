// Class B recoverable handoff policy and executor. Authority stays in code:
// the class, legal initiators, permanent gates, known predicates, and the
// live-execution requirement cannot be widened by the readable policy file.
// The file may only enable known conditions and tune their thresholds.
//
// The reaper seam is metadata.reaperVerdict. The reaper decides whether an
// execution is dead; this module decides whether wanted work should move.

var fs = require("fs");
var os = require("os");
var path = require("path");
var handoffModule = require("./coop-control-handoff");
var projectIdentity = require("./project-identity");
var recoveryLog = require("./recovery-log");
var taskGraph = require("./orchestration-task-graph");

var SCHEMA = "clay.coop_class_b_handoff_trigger_policy";
var VERSION = 1;

// The master switch. Absent or anything other than "1" means the trigger never
// evaluates anything, which is how this lands.
var TRIGGER_ENV = "CLAY_COOP_HANDOFF_TRIGGER";

// ---------------------------------------------------------------------------
// Authority. Code only.
// ---------------------------------------------------------------------------

var TRIGGER_CLASS = "B";

var INITIATORS = Object.freeze(Object.assign(Object.create(null), {
  coordinator: true,
  daemon: true,
  owner: true,
}));

// These observed states look handoff-shaped but require an owner decision,
// retry, wait, or terminal reconciliation instead. A policy edit cannot enable
// them.
var PERMANENTLY_GATED = Object.freeze([
  "capacity_exhausted",
  "owner_input_pending",
  "provider_start_failed",
  "scope_expansion",
  "terminal_execution",
  "worker_self_request",
]);

// One handoff per sweep per project. A sweep that can fire ten times can
// reassign a project's whole coordinator population off one bad threshold.
var MAX_FIRES_PER_SWEEP = 1;

var TERMINAL_EXECUTION_STATUS = Object.freeze(Object.assign(Object.create(null), {
  cancelled: true, completed: true, failed: true, superseded: true,
}));

var OWNER_BLOCKED_STATUS = Object.freeze(Object.assign(Object.create(null), {
  needs_input: true, waiting_user: true,
}));

// ---------------------------------------------------------------------------
// The condition catalogue. This literal is the readable copy published to
// ~/.clay/lead/coop-handoff-trigger-policy.json; the file is what production
// reads. "producer" names the code that must stamp the evidence a condition
// needs, so a disabled condition says why it is disabled instead of pretending.
// ---------------------------------------------------------------------------

var DEFAULT_CONDITIONS = [
  {
    conditionId: "runtime_dead_work_wanted",
    controllerReason: "wedged_thread",
    initiator: "daemon",
    enabled: true,
    minIdleMs: 3600000,
    minFailures: 0,
    producer: "coop-execution-reaper (metadata.reaperVerdict), else idle fallback",
    note: "A live controlled execution with no turn activity and no live " +
      "provider work. Handoff rather than retry because the predecessor's " +
      "provider process is gone while its control row is still current, so a " +
      "retry would restart from the brief and lose everything the " +
      "predecessor established. Handoff rather than failure because the " +
      "binding is still active and the task is not terminal.",
  },
  {
    conditionId: "owner_requested_relief",
    controllerReason: "owner_stuck",
    initiator: "owner",
    enabled: true,
    minIdleMs: 0,
    minFailures: 0,
    producer: "owner decision path (metadata.handoffRequest)",
    note: "The owner has looked at a stuck execution and asked for the work " +
      "to continue elsewhere. The only condition whose initiator is the owner.",
  },
  {
    conditionId: "context_exhausted_mid_task",
    controllerReason: "context_exhausted",
    initiator: "coordinator",
    enabled: false,
    minIdleMs: 0,
    minFailures: 0,
    producer: "NOT WIRED -- needs project-session-compaction to stamp " +
      "metadata.contextExhaustion on a live execution",
    note: "Handoff rather than retry because the same session hits the same " +
      "context wall on its next turn. Disabled until its producer exists; " +
      "enabling it before then would make it match nothing, silently.",
  },
  {
    conditionId: "repeated_gate_failure",
    controllerReason: "reasoning_corruption",
    initiator: "coordinator",
    enabled: false,
    minIdleMs: 0,
    minFailures: 3,
    producer: "NOT WIRED -- needs the review gate to stamp " +
      "metadata.gateFailures with a per-gate count",
    note: "Handoff rather than retry because N retries against the same gate " +
      "have already happened -- that count IS the retry policy, exhausted. " +
      "Disabled until its producer exists.",
  },
  {
    conditionId: "provider_route_unhealthy",
    controllerReason: "provider_unhealthy",
    initiator: "daemon",
    enabled: false,
    minIdleMs: 0,
    minFailures: 0,
    producer: "NOT WIRED -- needs sdk-provider-failover-signals to stamp " +
      "metadata.providerFailover on a live execution",
    note: "Handoff only for a non-limit failure: a limit failure is " +
      "capacity_exhausted, which is permanently gated. Disabled until its " +
      "producer exists.",
  },
];

// ---------------------------------------------------------------------------
// Predicates. Code, keyed by condition id, so the file cannot invent a
// condition. Each receives the derived observation and that condition's
// tunable configuration.
// ---------------------------------------------------------------------------

var PREDICATES = Object.create(null);

PREDICATES.runtime_dead_work_wanted = function (observation, config) {
  var verdict = observation.reaperVerdict;
  if (verdict) return verdict.dead === true && verdict.workWanted === true;
  return observation.isProcessing !== true &&
    observation.idleMs >= Number(config.minIdleMs);
};

PREDICATES.owner_requested_relief = function (observation) {
  return observation.ownerRelief === true;
};

PREDICATES.context_exhausted_mid_task = function (observation) {
  return observation.contextExhausted === true;
};

PREDICATES.repeated_gate_failure = function (observation, config) {
  return Number(observation.gateFailures) >= Number(config.minFailures) &&
    Number(config.minFailures) > 0;
};

PREDICATES.provider_route_unhealthy = function (observation) {
  return observation.providerUnhealthy === true &&
    observation.providerLimitFailure !== true;
};

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isPermanentlyGated(conditionId) {
  return PERMANENTLY_GATED.indexOf(String(conditionId || "")) !== -1;
}

function isHandoffTriggerEnabled(options) {
  var opts = options || {};
  if (typeof opts.enabled === "boolean") return opts.enabled;
  var env = opts.env || process.env;
  return !!(env && env[TRIGGER_ENV] === "1" &&
    handoffModule.isHandoffControlEnabled({ env: env }));
}

function defaultPolicyFile() {
  return path.join(os.homedir(), ".clay", "lead", "coop-handoff-trigger-policy.json");
}

function defaultPolicy() {
  return { schema: SCHEMA, version: VERSION, conditions: clone(DEFAULT_CONDITIONS) };
}

// A condition survives normalization only if code already knows it: it must
// have a predicate, a controller reason the handoff controller actually
// accepts, a legal initiator, and it must not be permanently gated. Anything
// else is dropped rather than silently trusted.
function normalizeCondition(value) {
  if (!plainObject(value)) return null;
  var conditionId = typeof value.conditionId === "string" ? value.conditionId.trim() : "";
  var known = null;
  for (var i = 0; i < DEFAULT_CONDITIONS.length; i++) {
    if (DEFAULT_CONDITIONS[i].conditionId === conditionId) known = DEFAULT_CONDITIONS[i];
  }
  if (!conditionId || !known || typeof PREDICATES[conditionId] !== "function") return null;
  if (isPermanentlyGated(conditionId)) return null;
  // Reason, initiator and class are authority, so they are taken from code and
  // the file's copies are only accepted when they agree.
  if (!Object.prototype.hasOwnProperty.call(handoffModule.REASONS, known.controllerReason)) return null;
  if (INITIATORS[known.initiator] !== true) return null;
  if (Object.prototype.hasOwnProperty.call(value, "controllerReason") &&
      value.controllerReason !== known.controllerReason) return null;
  if (Object.prototype.hasOwnProperty.call(value, "initiator") &&
      value.initiator !== known.initiator) return null;
  var minIdleMs = Number(value.minIdleMs);
  var minFailures = Number(value.minFailures);
  return {
    conditionId: conditionId,
    controllerReason: known.controllerReason,
    initiator: known.initiator,
    enabled: value.enabled === true,
    minIdleMs: Number.isFinite(minIdleMs) && minIdleMs >= 0 ? minIdleMs : known.minIdleMs,
    minFailures: Number.isFinite(minFailures) && minFailures >= 0 ? minFailures : known.minFailures,
    producer: known.producer,
    note: known.note,
  };
}

function normalizePolicy(value) {
  if (!plainObject(value) || value.schema !== SCHEMA || value.version !== VERSION ||
      !Array.isArray(value.conditions)) return null;
  var seen = Object.create(null);
  var conditions = [];
  for (var i = 0; i < value.conditions.length; i++) {
    var condition = normalizeCondition(value.conditions[i]);
    if (!condition || seen[condition.conditionId]) continue;
    seen[condition.conditionId] = true;
    conditions.push(condition);
  }
  conditions.sort(function (left, right) {
    return left.conditionId.localeCompare(right.conditionId);
  });
  return { schema: SCHEMA, version: VERSION, conditions: conditions };
}

// ---------------------------------------------------------------------------
// The decision. Pure: no store, no session mutation.
// ---------------------------------------------------------------------------

function decide(policy, observation) {
  var normalized = normalizePolicy(policy);
  if (!normalized) return { ok: false, code: "handoff_trigger_policy_malformed" };
  var value = observation || {};
  if (!projectIdentity.normalizeSessionRef(value.sessionRef)) {
    return { ok: false, code: "handoff_trigger_session_ref_required" };
  }
  if (value.initiator === "worker") {
    return { ok: false, code: "handoff_trigger_worker_may_not_initiate" };
  }
  // Gates that hold for every condition, so no file edit can reach past them.
  if (value.controlPresent !== true) {
    return { ok: false, code: "handoff_trigger_uncontrolled_execution" };
  }
  if (TERMINAL_EXECUTION_STATUS[value.status] === true) {
    return { ok: false, code: "handoff_trigger_terminal_execution" };
  }
  if (OWNER_BLOCKED_STATUS[value.status] === true) {
    return { ok: false, code: "handoff_trigger_owner_input_pending" };
  }
  if (value.alreadyHandedOff === true) {
    return { ok: false, code: "handoff_trigger_already_handed_off" };
  }
  for (var i = 0; i < normalized.conditions.length; i++) {
    var condition = normalized.conditions[i];
    if (!condition.enabled) continue;
    if (value.initiator && value.initiator !== condition.initiator) continue;
    if (PREDICATES[condition.conditionId](value, condition) !== true) continue;
    return {
      ok: true,
      conditionId: condition.conditionId,
      controllerReason: condition.controllerReason,
      handoffClass: TRIGGER_CLASS,
      initiator: condition.initiator,
    };
  }
  return { ok: false, code: "handoff_trigger_no_condition_matched" };
}

// ---------------------------------------------------------------------------
// The readable policy copy.
// ---------------------------------------------------------------------------

function createTriggerPolicyStore(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultPolicyFile();

  function load() {
    var parsed;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    } catch (error) {
      if (error && error.code === "ENOENT") return { ok: true, policy: defaultPolicy() };
      return { ok: false, code: "handoff_trigger_policy_unreadable" };
    }
    var policy = normalizePolicy(parsed);
    return policy ? { ok: true, policy: policy } :
      { ok: false, code: "handoff_trigger_policy_malformed" };
  }

  function save(policy) {
    var normalized = normalizePolicy(policy);
    if (!normalized) return { ok: false, code: "handoff_trigger_policy_malformed" };
    var temporary = file + ".tmp." + process.pid;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(temporary, JSON.stringify(normalized, null, 2) + "\n");
      fsImpl.renameSync(temporary, file);
      return { ok: true, policy: clone(normalized) };
    } catch (error) {
      try { fsImpl.unlinkSync(temporary); } catch (cleanupError) {}
      return { ok: false, code: "handoff_trigger_policy_persistence_failed" };
    }
  }

  return {
    file: file,
    load: load,
    publishDefaults: function () { return save(defaultPolicy()); },
    save: save,
  };
}

// A persisted system_info item is the owner-visible surface; the orchestration
// event is durable server evidence but is not projected into the transcript.

function handoffNotice(info) {
  return "Class B handoff fired. Condition: " + info.conditionId + ". Reason: " +
    info.controllerReason + ". Initiated by: " + info.initiator +
    ". Work moved from session " + info.from.sessionStorageId + " to " +
    info.successor.sessionStorageId + " in project " + info.successor.projectId +
    ". Handoff " + info.handoffId + ", successor receipt " + info.receiptId + ".";
}

function surfaceHandoff(deps, info) {
  var surfaced = { transcript: false, task: false, canary: false };
  var coordinator = deps.coordinator;
  var leadManager = deps.leadManager;
  if (coordinator && leadManager) {
    var item = {
      type: "system_info",
      text: handoffNotice(info),
      coopHandoff: {
        conditionId: info.conditionId, controllerReason: info.controllerReason,
        handoffClass: TRIGGER_CLASS, handoffId: info.handoffId,
        initiator: info.initiator, receiptId: info.receiptId,
        from: info.from, successor: info.successor,
      },
      _ts: Date.now(),
    };
    if (!Array.isArray(coordinator.history)) coordinator.history = [];
    coordinator.history.push(item);
    if (typeof leadManager.appendToSessionFile === "function") {
      leadManager.appendToSessionFile(coordinator, item);
    }
    if (typeof deps.sendToSession === "function") {
      deps.sendToSession(coordinator.localId, item);
    }
    surfaced.transcript = true;
    if (info.task) {
      info.task.currentActivity = ("Handed off to " +
        info.successor.sessionStorageId + " (" + info.conditionId + ")").slice(0, 240);
      info.task.updatedAt = Date.now();
      taskGraph.appendEvent(coordinator, "execution_handed_off", info.task, {
        conditionId: info.conditionId, controllerReason: info.controllerReason,
        handoffId: info.handoffId, initiator: info.initiator,
        receiptId: info.receiptId, from: info.from, successor: info.successor,
      });
      surfaced.task = true;
    }
    if (typeof leadManager.saveSessionFile === "function") {
      leadManager.saveSessionFile(coordinator, { durable: true });
    }
    if (typeof leadManager.broadcastSessionList === "function") {
      leadManager.broadcastSessionList();
    }
  }
  // The documented diagnostic surface (docs/guides/DIAGNOSTICS.md points the
  // owner at the canary logs before source code).
  recoveryLog.recordRecoveryEvent({
    kind: "coop_class_b_handoff", ok: true, conditionId: info.conditionId,
    controllerReason: info.controllerReason, initiator: info.initiator,
    handoffId: info.handoffId, receiptId: info.receiptId,
    from: info.from, successor: info.successor,
  });
  surfaced.canary = true;
  return surfaced;
}

function recordDeclined(observation, decision) {
  recoveryLog.recordRecoveryEvent({
    kind: "coop_class_b_handoff", ok: false, code: decision.code,
    sessionRef: observation && observation.sessionRef || null,
  });
}

// ---------------------------------------------------------------------------
// The trigger.
// ---------------------------------------------------------------------------

function createHandoffTrigger(options) {
  var opts = options || {};
  var store = opts.policyStore || createTriggerPolicyStore({ fs: opts.fs, file: opts.policyFile });
  var enabled = isHandoffTriggerEnabled(opts);

  function fire(context, observation) {
    var loaded = store.load();
    if (!loaded.ok) {
      recordDeclined(observation, loaded);
      return { ok: false, code: loaded.code };
    }
    var decision = decide(loaded.policy, observation);
    if (!decision.ok) {
      recordDeclined(observation, decision);
      return decision;
    }
    var adapter = typeof context.adapter === "function" ? context.adapter() : null;
    if (!adapter || typeof adapter.handoffLiveExecution !== "function") {
      return { ok: false, code: "handoff_trigger_adapter_unavailable" };
    }
    var result = adapter.handoffLiveExecution({
      from: observation.sessionRef,
      objective: observation.objective,
      reason: decision.controllerReason,
    });
    if (!result) return { ok: false, code: "handoff_trigger_execution_not_live" };
    var info = {
      conditionId: decision.conditionId,
      controllerReason: decision.controllerReason,
      from: result.from,
      handoffId: result.handoff.handoffId,
      initiator: decision.initiator,
      receiptId: result.handoff.successorReceiptId,
      successor: result.successor,
      task: observation.task || context.task || null,
    };
    var surfaced = surfaceHandoff({
      coordinator: context.coordinator, leadManager: context.leadManager,
      sendToSession: context.sendToSession,
    }, info);
    return { ok: true, decision: decision, handoff: result.handoff,
      successor: result.successor, surfaced: surfaced };
  }

  // One sweep, one project. Bounded by MAX_FIRES_PER_SWEEP in code.
  function sweep(context) {
    if (!enabled) return { ok: true, enabled: false, fired: [], evaluated: 0 };
    var value = context || {};
    var observations = typeof value.observe === "function" ? value.observe() : [];
    var list = Array.isArray(observations) ? observations : [];
    var fired = [];
    var declined = [];
    for (var i = 0; i < list.length && fired.length < MAX_FIRES_PER_SWEEP; i++) {
      var result = fire(value, list[i]);
      if (result.ok) fired.push(result);
      else declined.push({ code: result.code, sessionRef: list[i] && list[i].sessionRef || null });
    }
    return { ok: true, enabled: true, declined: declined, evaluated: list.length, fired: fired };
  }

  return { enabled: enabled, fire: fire, policyStore: store, sweep: sweep };
}

module.exports = {
  DEFAULT_CONDITIONS: Object.freeze(DEFAULT_CONDITIONS),
  INITIATORS: INITIATORS,
  MAX_FIRES_PER_SWEEP: MAX_FIRES_PER_SWEEP,
  PERMANENTLY_GATED: PERMANENTLY_GATED,
  SCHEMA: SCHEMA,
  TRIGGER_CLASS: TRIGGER_CLASS,
  TRIGGER_ENV: TRIGGER_ENV,
  VERSION: VERSION,
  createHandoffTrigger: createHandoffTrigger,
  createTriggerPolicyStore: createTriggerPolicyStore,
  decide: decide,
  defaultPolicy: defaultPolicy,
  defaultPolicyFile: defaultPolicyFile,
  handoffNotice: handoffNotice,
  isHandoffTriggerEnabled: isHandoffTriggerEnabled,
  isPermanentlyGated: isPermanentlyGated,
  normalizePolicy: normalizePolicy,
};
