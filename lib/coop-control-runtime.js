// Process-local owner of the optional Slice 2 controller. Activation requires
// both ControlStore flags; flag-off callers receive a no-op controller.

var executions = require("./coop-control-executions");
var deliveryModule = require("./coop-control-delivery");
var handoffModule = require("./coop-control-handoff");
var startupModule = require("./coop-control-startup");
var projectIdentity = require("./project-identity");

var singleton = null;
var handoffSingleton = null;
var deliverySingleton = null;
var startupSingleton = null;
var recoveryTargets = Object.create(null);
var activeRecovery = null;
var scheduledRecovery = null;
var recoveryGeneration = 0;

function recoveryError(message) {
  var error = new Error(message);
  error.code = "COOP_CONTROL_RECOVERY_TARGET_UNREGISTERED";
  return error;
}

function registerRecoveryTarget(value) {
  var spec = value || {};
  var project = projectIdentity.normalizeProjectRef(spec.projectRef || { projectId: spec.projectId });
  if (!project || !spec.sessionManager || !spec.recoveryHandlers ||
      typeof spec.recoveryHandlers !== "object") {
    throw recoveryError("Coop recovery target registration requires an exact ProjectRef and SessionManager.");
  }
  recoveryTargets[project.projectId] = { handlers: spec.recoveryHandlers,
    projectRef: project, sessionManager: spec.sessionManager };
  return project;
}

function targetHandlers(ref, method) {
  var project = projectIdentity.normalizeProjectRef(ref);
  var target = project && recoveryTargets[project.projectId];
  if (!target || typeof target.handlers[method] !== "function") {
    throw recoveryError("Coop startup recovery target " +
      String(project && project.projectId || "unknown") + " is not registered for " + method + ".");
  }
  return target.handlers;
}

function recoveryMultiplexer() {
  return {
    activate: function (record, token, recovery) {
      var ref = recovery && recovery.target || record.to;
      return targetHandlers(ref, "activate").activate(record, token, recovery);
    },
    applyEffect: function (effect) {
      return targetHandlers(effect.target, "applyEffect").applyEffect(effect);
    },
    cleanupAbortedSuccessor: function (record) {
      return targetHandlers(record.to, "cleanupAbortedSuccessor").cleanupAbortedSuccessor(record);
    },
    cleanupReceived: function () {
      var ids = Object.keys(recoveryTargets).sort();
      var cleaned = 0;
      for (var i = 0; i < ids.length; i++) {
        var handler = recoveryTargets[ids[i]].handlers;
        if (typeof handler.cleanupReceived === "function") cleaned += Number(handler.cleanupReceived()) || 0;
      }
      return cleaned;
    },
    rehydrate: function (record, checkpoint, token, recovery) {
      var ref = recovery && recovery.target || record.to;
      return targetHandlers(ref, "rehydrate").rehydrate(record, checkpoint, token, recovery);
    },
    send: function (stable) {
      return targetHandlers(stable.recipient, "send").send(stable);
    },
    successorEvidence: function (record) {
      return targetHandlers(record.to, "successorEvidence").successorEvidence(record);
    },
  };
}

function getExecutionControl(options) {
  var opts = options || {};
  if (opts.control) return opts.control;
  if (!singleton) {
    singleton = executions.createExecutionControl(opts);
    if (singleton.enabled && !handoffModule.isHandoffControlEnabled(opts)) singleton.recoverIncomplete();
  }
  return singleton;
}

function getHandoffControl(options) {
  var opts = options || {};
  if (opts.handoffControl) return opts.handoffControl;
  if (!handoffModule.isHandoffControlEnabled(opts)) {
    if (!handoffSingleton) handoffSingleton = handoffModule.createHandoffControl(opts);
    return handoffSingleton;
  }
  if (!handoffSingleton) {
    var control = getExecutionControl(opts);
    handoffSingleton = handoffModule.createHandoffControl(Object.assign({}, opts, {
      store: control.getStore(), executionControl: control,
    }));
  }
  return handoffSingleton;
}

function getDeliveryControl(options) {
  var opts = options || {};
  if (opts.deliveryControl) return opts.deliveryControl;
  if (!deliveryModule.isDeliveryControlEnabled(opts)) {
    if (!deliverySingleton) deliverySingleton = deliveryModule.createDeliveryControl(opts);
    return deliverySingleton;
  }
  if (!deliverySingleton) {
    var control = getExecutionControl(opts);
    deliverySingleton = deliveryModule.createDeliveryControl(Object.assign({}, opts, {
      store: control.getStore(),
    }));
  }
  return deliverySingleton;
}

function getStartupRecovery(options) {
  var opts = options || {};
  if (opts.startupRecovery) return opts.startupRecovery;
  if (!startupModule.isStartupRecoveryEnabled(opts)) {
    if (!startupSingleton) startupSingleton = startupModule.createStartupRecovery(opts);
    return startupSingleton;
  }
  if (!startupSingleton) {
    var control = getExecutionControl(opts);
    startupSingleton = startupModule.createStartupRecovery(Object.assign({}, opts, {
      store: control.getStore(), executionControl: control,
      handoffControl: getHandoffControl(opts), deliveryControl: getDeliveryControl(opts),
    }));
  }
  return startupSingleton;
}

function recoverStartup(options, handlers) {
  var opts = options || {};
  var callbacks = handlers || opts.recoveryHandlers || recoveryMultiplexer();
  if (!callbacks || typeof callbacks !== "object") {
    throw new Error("Coop startup recovery requires wired production handlers.");
  }
  if (activeRecovery) return activeRecovery;
  var result = getStartupRecovery(opts).recover(callbacks);
  if (result && typeof result.then === "function") {
    activeRecovery = result.then(function (value) { activeRecovery = null; return value; },
      function (error) { activeRecovery = null; throw error; });
    return activeRecovery;
  }
  return result;
}

function scheduleStartupRecovery(options) {
  var opts = options || {};
  if (scheduledRecovery) return scheduledRecovery;
  var generation = recoveryGeneration;
  scheduledRecovery = new Promise(function (resolve, reject) {
    setImmediate(function () {
      scheduledRecovery = null;
      if (generation !== recoveryGeneration) return resolve(null);
      try {
        var result = recoverStartup(opts);
        if (result && typeof result.then === "function") result.then(resolve, reject);
        else resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
  return scheduledRecovery;
}

function assertRecoveryReady(options) {
  if (!handoffModule.isHandoffControlEnabled(options)) return true;
  return getStartupRecovery(options).assertReady();
}

function closeExecutionControl() {
  recoveryGeneration += 1;
  if (startupSingleton) startupSingleton.close();
  if (deliverySingleton) deliverySingleton.close();
  if (handoffSingleton) handoffSingleton.close();
  if (singleton) singleton.close();
  startupSingleton = null;
  deliverySingleton = null;
  handoffSingleton = null;
  singleton = null;
  recoveryTargets = Object.create(null);
  activeRecovery = null;
  scheduledRecovery = null;
}

module.exports = {
  closeExecutionControl: closeExecutionControl,
  assertRecoveryReady: assertRecoveryReady,
  getDeliveryControl: getDeliveryControl,
  getExecutionControl: getExecutionControl,
  getHandoffControl: getHandoffControl,
  getStartupRecovery: getStartupRecovery,
  registerRecoveryTarget: registerRecoveryTarget,
  recoverStartup: recoverStartup,
  scheduleStartupRecovery: scheduleStartupRecovery,
};
