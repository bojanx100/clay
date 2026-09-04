// Exact continuity-to-control verification. This adapter deliberately accepts
// only durable execution rows and an injected canonical binding snapshot.

var validation = require("./coop-control-store-validation");

function error(message) {
  return validation.taggedError("COOP_CONTROL_CONTINUITY_MISMATCH", message);
}

function sameSession(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

function sameProject(left, right) {
  return !!left && !!right && left.projectId === right.projectId;
}

function sameBinding(left, right) {
  return !!left && !!right && left.portfolioTaskId === right.portfolioTaskId &&
    Number(left.bindingRevision) === Number(right.bindingRevision) &&
    sameProject(left.targetProject, right.targetProject) && left.mode === right.mode &&
    left.status === right.status;
}

function sameAuthority(left, right) {
  return !!left && !!right && left.authorityId === right.authorityId &&
    sameSession(left.source, right.source) && left.portfolioTaskId === right.portfolioTaskId &&
    Number(left.bindingRevision) === Number(right.bindingRevision) &&
    sameProject(left.targetProject, right.targetProject) && left.role === right.role &&
    Number(left.actionMask) === Number(right.actionMask);
}

function sameExecution(left, right) {
  return !!left && !!right && left.executionId === right.executionId &&
    left.authorityId === right.authorityId && sameSession(left.source, right.source) &&
    left.portfolioTaskId === right.portfolioTaskId &&
    Number(left.bindingRevision) === Number(right.bindingRevision) &&
    sameProject(left.targetProject, right.targetProject) && left.mode === right.mode &&
    left.role === right.role;
}

function find(values, key, value) {
  for (var i = 0; i < values.length; i++) {
    if (values[i][key] === value) return values[i];
  }
  return null;
}

function durableExecutionSnapshot(control, predecessor, from) {
  var inspected = control.inspect(predecessor.executionId);
  if (!inspected || !inspected.execution || !inspected.authority || !inspected.current ||
      inspected.current.incarnationId !== predecessor.incarnationId ||
      Number(inspected.current.epoch) !== Number(predecessor.epoch) ||
      inspected.authority.authorityId !== predecessor.authorityId ||
      inspected.authority.role !== predecessor.role || !sameSession(inspected.current.sessionRef, from)) {
    throw error("The predecessor capability does not match durable execution truth.");
  }
  return inspected;
}

function packetExecutionFor(packet, predecessor) {
  var execution = find(packet.executions, "executionId", predecessor.executionId);
  if (!execution) throw error("Continuity does not contain the predecessor execution.");
  return execution;
}

function verifyPacketAgainstDurable(packet, predecessor, inspected) {
  var execution = packetExecutionFor(packet, predecessor);
  var authority = find(packet.authorities, "authorityId", predecessor.authorityId);
  var binding = null;
  var task = find(packet.tasks, "taskId", execution.portfolioTaskId);
  for (var i = 0; i < packet.bindings.length; i++) {
    if (packet.bindings[i].portfolioTaskId === execution.portfolioTaskId &&
        Number(packet.bindings[i].bindingRevision) === Number(execution.bindingRevision)) {
      binding = packet.bindings[i];
      break;
    }
  }
  var durableExecution = {
    executionId: inspected.execution.executionId,
    authorityId: inspected.authority.authorityId,
    source: inspected.authority.source,
    portfolioTaskId: inspected.execution.portfolioTaskId,
    bindingRevision: inspected.execution.bindingRevision,
    targetProject: inspected.execution.targetProject,
    mode: inspected.execution.mode,
    role: inspected.authority.role,
  };
  if (!task || !binding || !authority || !sameExecution(execution, durableExecution) ||
      !sameAuthority(authority, inspected.authority) ||
      binding.portfolioTaskId !== durableExecution.portfolioTaskId ||
      Number(binding.bindingRevision) !== Number(durableExecution.bindingRevision) ||
      !sameProject(binding.targetProject, durableExecution.targetProject) ||
      binding.mode !== durableExecution.mode || task.taskId !== durableExecution.portfolioTaskId) {
    throw error("Continuity execution, task, binding, or authority differs from durable predecessor truth.");
  }
  return { authority: authority, binding: binding, execution: execution, task: task };
}

function createContinuityVerifier(options) {
  var opts = options || {};
  var control = opts.executionControl;
  var canonicalBinding = opts.canonicalBinding;
  if (!control || typeof control.inspect !== "function") {
    throw error("A durable execution-control inspector is required.");
  }

  return function verify(packet, predecessor, from) {
    var durable = durableExecutionSnapshot(control, predecessor, from);
    var matched = verifyPacketAgainstDurable(packet, predecessor, durable);
    if (typeof canonicalBinding !== "function") return true;
    var canonical = canonicalBinding(matched.execution.portfolioTaskId, matched.execution.bindingRevision);
    if (!canonical || !sameBinding(matched.binding, canonical)) {
      throw error("Continuity binding differs from the canonical durable binding.");
    }
    return true;
  };
}

module.exports = {
  createContinuityVerifier: createContinuityVerifier,
  sameAuthority: sameAuthority,
  sameBinding: sameBinding,
  sameExecution: sameExecution,
};
