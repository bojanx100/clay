// Startup recovery barrier. Controlled execution intake stays closed until
// handoffs, stable delivery, effects, and checkpoint exams have converged.

var controlStore = require("./coop-control-store");
var deliveryModule = require("./coop-control-delivery");
var executions = require("./coop-control-executions");
var handoffModule = require("./coop-control-handoff");
var validation = require("./coop-control-store-validation");

function error(code, message, cause) {
  return validation.taggedError(code, message, cause);
}

function isStartupRecoveryEnabled(options) {
  return handoffModule.isHandoffControlEnabled(options);
}

function disabledRecovery() {
  return { enabled: false, assertReady: function () { return true; }, close: function () {},
    isReady: function () { return true; }, recover: function () {
      return { enabled: false, recoveredHandoffs: 0, abortedHandoffs: 0,
        recoveredExecutions: 0, replayedMessages: 0, reconciledEffects: 0 };
    }, state: function () { return "disabled"; } };
}

var TERMINAL_EXECUTIONS = Object.freeze(Object.assign(Object.create(null), {
  cancelled: "failed", completed: "completed", failed: "failed",
}));

function sameSessionRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

function isSafeTerminalRestartHandoff(item, durable) {
  var execution = durable && durable.execution;
  var current = durable && durable.current;
  var expectedStartState = execution && TERMINAL_EXECUTIONS[execution.status];
  return !!expectedStartState && item.state === "prepared" && item.handoffClass === "A" &&
    item.handoffId.indexOf("handoff:restart:") === 0 && item.reason === "provider_unhealthy" &&
    item.successorState === "retained" && item.successorReceiptId === null &&
    sameSessionRef(item.from, item.to) && execution.executionId === item.executionId &&
    execution.finishedAt !== null && execution.currentEpoch === item.fromEpoch && current &&
    current.incarnationId === item.fromIncarnationId && current.epoch === item.fromEpoch &&
    current.startState === expectedStartState && sameSessionRef(current.sessionRef, item.from);
}

function createStartupRecovery(options) {
  var opts = options || {};
  if (!isStartupRecoveryEnabled(opts)) return disabledRecovery();
  var ownsStore = !opts.store;
  var storeOptions = { dbPath: opts.dbPath, faults: opts.storeFaults, fs: opts.fs, now: opts.now };
  if (Object.prototype.hasOwnProperty.call(opts, "sqliteModule")) storeOptions.sqliteModule = opts.sqliteModule;
  var store = opts.store || controlStore.openControlStore(storeOptions);
  var ownsExecution = !opts.executionControl;
  var executionControl = opts.executionControl || executions.createExecutionControl({
    enabled: true, store: store, faults: opts.executionFaults, now: opts.now,
    randomBytes: opts.randomBytes, randomUUID: opts.randomUUID,
  });
  var ownsHandoff = !opts.handoffControl;
  var handoffControl = opts.handoffControl || handoffModule.createHandoffControl({
    enabled: true, store: store, executionControl: executionControl, faults: opts.handoffFaults,
    now: opts.now, randomBytes: opts.randomBytes, randomUUID: opts.randomUUID,
  });
  var ownsDelivery = !opts.deliveryControl;
  var deliveryControl = opts.deliveryControl || deliveryModule.createDeliveryControl({
    enabled: true, store: store, faults: opts.deliveryFaults, now: opts.now,
  });
  var faults = opts.faults || {};
  var barrierState = "closed";
  var lastResult = null;
  var failure = null;
  var closed = false;

  function assertOpen() {
    if (closed) throw error("COOP_CONTROL_RECOVERY_CLOSED", "Startup recovery is closed.");
  }

  function assertReady() {
    assertOpen();
    if (barrierState !== "open") {
      var code = barrierState === "recovery_required" ? "COOP_CONTROL_RESTART_RECOVERY_REQUIRED" :
        barrierState === "failed" ? "COOP_CONTROL_RECOVERY_FAILED" :
        "COOP_CONTROL_RECOVERY_BARRIER_CLOSED";
      var message = barrierState === "recovery_required" ?
        "Controlled execution restart requires explicit recovery." :
        barrierState === "failed" ? "Startup recovery failed closed." :
        "Startup recovery has not opened the execution barrier.";
      throw error(code, message, failure);
    }
    return true;
  }

  function then(value, next) {
    return value && typeof value.then === "function" ? value.then(next) : next(value);
  }

  function recoverHandoffs(callbacks, pending) {
    var recovered = 0;
    var aborted = 0;
    function recoverOne(i) {
      if (i >= pending.length) return { aborted: aborted, recovered: recovered };
      var item = pending[i];
      if (item.state === "prepared" && item.handoffClass === "B" &&
          item.successorState !== "created" && typeof callbacks.successorEvidence === "function") {
        var evidence = callbacks.successorEvidence(item);
        if (evidence) handoffControl.ensureSuccessor(item.handoffId, function () { return evidence; });
      }
      var recovery = handoffControl.recover(item.handoffId);
      if (!recovery.token) {
        aborted += 1;
        return recoverOne(i + 1);
      }
      var checkpoint = handoffControl.checkpoint(item.handoffId);
      if (!checkpoint || !checkpoint.exam || checkpoint.exam.passed !== true ||
          typeof callbacks.rehydrate !== "function") {
        throw error("COOP_CONTROL_REHYDRATION_FAILED",
          "Post-cutover recovery requires a passing transcript-free rehydration exam.");
      }
      return then(callbacks.rehydrate(recovery.handoff, checkpoint, recovery.token, recovery), function (rehydrated) {
        if (rehydrated !== true) {
          throw error("COOP_CONTROL_REHYDRATION_FAILED",
            "Post-cutover recovery requires a passing transcript-free rehydration exam.");
        }
        if (typeof callbacks.activate !== "function") {
          throw error("COOP_CONTROL_RECOVERY_ACTIVATION_REQUIRED",
            "Post-cutover recovery requires successor activation.");
        }
        return then(callbacks.activate(recovery.handoff, recovery.token, recovery), function (activated) {
          if (activated !== true) {
            throw error("COOP_CONTROL_RECOVERY_ACTIVATION_REQUIRED",
              "Post-cutover recovery requires successor activation.");
          }
          if (recovery.preCutover) {
            if (recovery.handoff.handoffClass === "B" && recovery.handoff.successorState === "created" &&
                typeof callbacks.cleanupAbortedSuccessor === "function" &&
                callbacks.cleanupAbortedSuccessor(recovery.handoff) !== true) {
              throw error("COOP_CONTROL_RECOVERY_SUCCESSOR_CLEANUP_REQUIRED",
                "Prepared Class B recovery could not clean its exact inactive successor.");
            }
            handoffControl.abort(item.handoffId, "restart_pre_cutover");
            aborted += 1;
          } else {
            handoffControl.complete(item.handoffId, recovery.token);
            recovered += 1;
          }
          return recoverOne(i + 1);
        });
      });
    }
    return recoverOne(0);
  }

  function replayOutbox(callbacks) {
    if (!store.listOutbox(true).length) return 0;
    if (typeof callbacks.send !== "function") {
      throw error("COOP_CONTROL_RECOVERY_DELIVERY_REQUIRED",
        "Pending stable messages must replay before the startup barrier opens.");
    }
    var replayed = deliveryControl.dispatch(callbacks.send);
    if (store.listOutbox(true).length) {
      throw error("COOP_CONTROL_RECOVERY_DELIVERY_PENDING",
        "Stable message replay did not acknowledge every pending outbox row.");
    }
    return replayed;
  }

  function reconcileEffects(callbacks, pending) {
    if (pending.length && typeof callbacks.applyEffect !== "function") {
      throw error("COOP_CONTROL_RECOVERY_EFFECT_REQUIRED",
        "Effect reconciliation must finish before the startup barrier opens.");
    }
    var reconciled = pending.length ? deliveryControl.reconcilePending(pending, callbacks.applyEffect) : 0;
    return then(reconciled, function (count) {
      if (typeof callbacks.cleanupReceived === "function") callbacks.cleanupReceived();
      return count;
    });
  }

  function pendingExecutionTargets(effects) {
    var targets = [];
    var seen = Object.create(null);
    function add(projectId, sessionStorageId) {
      var key = projectId + "\u0000" + sessionStorageId;
      if (!projectId || !sessionStorageId || seen[key]) return;
      seen[key] = true;
      targets.push({ projectId: projectId, sessionStorageId: sessionStorageId });
    }
    for (var effectIndex = 0; effectIndex < effects.length; effectIndex++) {
      if (effects[effectIndex].kind === "execution_update") {
        add(effects[effectIndex].target.projectId, effects[effectIndex].target.sessionStorageId);
      }
    }
    var outbox = store.listOutbox(true);
    for (var outboxIndex = 0; outboxIndex < outbox.length; outboxIndex++) {
      if (outbox[outboxIndex].message_kind === "execution_event") {
        add(outbox[outboxIndex].recipient_project_id, outbox[outboxIndex].recipient_session_id);
      }
    }
    return targets;
  }

  function performRecovery(callbacks) {
    var result = { enabled: true, recoveredHandoffs: 0, abortedHandoffs: 0,
      recoveredExecutions: 0, replayedMessages: 0, reconciledEffects: 0 };
    var protectedExecutions = Object.create(null);
    function recoverPass(pass) {
      if (pass >= 32) {
        throw error("COOP_CONTROL_RECOVERY_FIXED_POINT_REQUIRED",
          "Startup recovery produced more work than its bounded serialized fixed point permits.");
      }
      // Classify every handoff before generic recovery. A prepared handoff owns
      // its predecessor lease until it is explicitly aborted, so it must never
      // be terminalized as an unrelated interrupted execution.
      var pending = handoffControl.listRecoverable();
      var recoverable = [];
      for (var pendingIndex = 0; pendingIndex < pending.length; pendingIndex++) {
        var item = pending[pendingIndex];
        var durable = executionControl.inspect(item.executionId);
        if (!durable || !durable.execution) {
          throw error("COOP_CONTROL_RESTART_RECOVERY_REQUIRED",
            "A recoverable handoff has no durable controlled execution.");
        }
        if (TERMINAL_EXECUTIONS[durable.execution.status]) {
          if (durable.leases.length !== 0 || !isSafeTerminalRestartHandoff(item, durable)) {
            throw error("COOP_CONTROL_RESTART_RECOVERY_REQUIRED",
              "A terminal controlled execution has a handoff that cannot be safely reconciled.");
          }
          handoffControl.abort(item.handoffId, "terminal_execution_reconciled");
          result.abortedHandoffs += 1;
          continue;
        }
        recoverable.push(item);
      }
      pending = recoverable;
      var pendingEffects = deliveryControl.listPendingEffects();
      var handoffExecutions = Object.create(null);
      for (var itemIndex = 0; itemIndex < pending.length; itemIndex++) {
        handoffExecutions[pending[itemIndex].executionId] = true;
        protectedExecutions[pending[itemIndex].executionId] = true;
      }
      var replayExecutions = executionControl.findRecoveryTargets(pendingExecutionTargets(pendingEffects));
      var replayTargets = [];
      for (var replayIndex = 0; replayIndex < replayExecutions.length; replayIndex++) {
        protectedExecutions[replayExecutions[replayIndex].executionId] = true;
        if (!handoffExecutions[replayExecutions[replayIndex].executionId]) {
          replayTargets.push(replayExecutions[replayIndex].sessionRef);
        }
      }
      var excludedExecutions = Object.keys(protectedExecutions);
      if (typeof store.listIncompleteExecutions !== "function") {
        throw error("COOP_CONTROL_RESTART_RECOVERY_REQUIRED",
          "Controlled execution state cannot prove complete restart checkpoint coverage.");
      }
      result.recoveredExecutions += executionControl.recoverIncomplete(excludedExecutions);
      var incomplete = store.listIncompleteExecutions();
      for (var incompleteIndex = 0; incompleteIndex < incomplete.length; incompleteIndex++) {
        if (!protectedExecutions[incomplete[incompleteIndex].execution_id]) {
          throw error("COOP_CONTROL_RESTART_RECOVERY_REQUIRED",
            "A checkpoint-missing controlled execution could not be quarantined for restart recovery.");
        }
      }
      executionControl.recoverTargets(replayTargets);
      return then(recoverHandoffs(callbacks, pending), function (handoffResult) {
        result.recoveredHandoffs += handoffResult.recovered;
        result.abortedHandoffs += handoffResult.aborted;
        result.replayedMessages += replayOutbox(callbacks);
        return then(reconcileEffects(callbacks, pendingEffects), function (reconciled) {
          result.reconciledEffects += reconciled;
          var remainingHandoffs = handoffControl.listRecoverable().length;
          var pendingOutbox = store.listOutbox(true).length;
          var intendedEffects = deliveryControl.countPendingEffects();
          if (!remainingHandoffs && !pendingOutbox && !intendedEffects) {
            if (typeof faults.beforeBarrierOpen === "function") faults.beforeBarrierOpen();
            return result;
          }
          return recoverPass(pass + 1);
        });
      });
    }
    return recoverPass(0);
  }

  function recover(handlers) {
    assertOpen();
    if (barrierState === "open") return lastResult;
    if (barrierState === "recovering") {
      throw error("COOP_CONTROL_RECOVERY_ACTIVE", "Startup recovery is already running.");
    }
    var callbacks = handlers || {};
    barrierState = "recovering";
    failure = null;
    try {
      var result = performRecovery(callbacks);
      function succeeded(value) {
        lastResult = value;
        barrierState = "open";
        return lastResult;
      }
      function failed(cause) {
        failure = cause;
        barrierState = cause && cause.code === "COOP_CONTROL_RESTART_RECOVERY_REQUIRED" ?
          "recovery_required" : "failed";
        throw cause;
      }
      return result && typeof result.then === "function" ? result.then(succeeded, failed) : succeeded(result);
    } catch (cause) {
      failure = cause;
      barrierState = cause && cause.code === "COOP_CONTROL_RESTART_RECOVERY_REQUIRED" ?
        "recovery_required" : "failed";
      throw cause;
    }
  }

  return { enabled: true, assertReady: assertReady,
    close: function () { if (closed) return; closed = true;
      if (ownsDelivery) deliveryControl.close(); if (ownsHandoff) handoffControl.close();
      if (ownsExecution) executionControl.close(); if (ownsStore) store.close(); },
    isReady: function () { return barrierState === "open"; }, recover: recover,
    state: function () { return barrierState; } };
}

module.exports = {
  attachCoopControlStartup: createStartupRecovery,
  createStartupRecovery: createStartupRecovery,
  createCoopControlStartup: createStartupRecovery,
  isStartupRecoveryEnabled: isStartupRecoveryEnabled,
};
