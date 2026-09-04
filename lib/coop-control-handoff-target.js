// Production handoff adapter. It creates a Class B successor through the
// SessionManager before the durable handoff is allowed to cut over.

var crypto = require("crypto");
var continuity = require("./coop-control-continuity");
var continuityVerifier = require("./coop-control-continuity-verifier");
var projectIdentity = require("./project-identity");

function receiptId(handoffId, ref) {
  return "receipt:" + crypto.createHash("sha256").update(handoffId + "\u0000" +
    ref.projectId + "\u0000" + ref.sessionStorageId, "utf8").digest("hex").slice(0, 48);
}

function sameRef(left, right) {
  return !!left && !!right && left.projectId === right.projectId &&
    left.sessionStorageId === right.sessionStorageId;
}

function then(value, next) {
  return value && typeof value.then === "function" ? value.then(next) : next(value);
}

function createProductionHandoffAdapter(options) {
  var opts = options || {};
  var sm = opts.sm;
  var control = opts.executionControl;
  var handoff = opts.handoffControl;
  var metadataFor = opts.executionMetadata;
  var projectId = opts.projectId;
  if (!sm || !control || !handoff || typeof metadataFor !== "function" ||
      typeof projectId !== "function") {
    throw new Error("Coop production handoff adapter requires target control dependencies.");
  }
  var verify = continuityVerifier.createContinuityVerifier({ executionControl: control,
    canonicalBinding: opts.canonicalBinding });

  function find(ref) {
    var found = null;
    sm.sessions.forEach(function (session) {
      if (!found && sameRef(projectIdentity.sessionRef({ projectId: projectId() }, session), ref)) found = session;
    });
    return found;
  }

  function reserveSuccessor(ref, source, handoffId) {
    var session = find(ref);
    var receipt = receiptId(handoffId, ref);
    if (!session) {
      session = sm.createSessionRaw({ storageId: ref.sessionStorageId, coordinationMode: true });
      var metadata = Object.assign({}, metadataFor(source) || {}, { status: "pending",
        recoveryPreallocation: { handoffId: handoffId, receiptId: receipt,
          sessionRef: { projectId: ref.projectId, sessionStorageId: ref.sessionStorageId } } });
      delete metadata.control;
      delete metadata.recoveryDeliveries;
      session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
        portfolioExecution: metadata,
      });
    }
    var existing = metadataFor(session);
    var marker = existing && existing.recoveryPreallocation;
    if (!marker || marker.handoffId !== handoffId || marker.receiptId !== receipt ||
        !sameRef(marker.sessionRef, ref) || session.isProcessing || existing.status !== "pending") {
      throw new Error("Class B successor SessionRef is not the exact inactive preallocation.");
    }
    sm.saveSessionFile(session, { durable: true });
    if (!find(ref)) throw new Error("SessionManager did not retain the preallocated successor SessionRef.");
    return { receiptId: receipt, sessionRef: ref };
  }

  function handoffExecution(input) {
    var value = input || {};
    var predecessor = value.predecessor;
    var source = find(value.from);
    var from = projectIdentity.normalizeSessionRef(value.from);
    var handoffClass = value.class;
    if (!source || !from || !predecessor || (handoffClass !== "A" && handoffClass !== "B")) {
      throw new Error("Production handoff requires an exact active source SessionRef and predecessor capability.");
    }
    var successor = handoffClass === "A" ? from : projectIdentity.normalizeSessionRef(value.successor) || {
      projectId: from.projectId, sessionStorageId: crypto.randomUUID(),
    };
    if (successor.projectId !== from.projectId || handoffClass === "B" && sameRef(successor, from)) {
      throw new Error("Class B successor must be preallocated in the same target project.");
    }
    verify(value.continuity, predecessor, from);
    var prepared = handoff.prepare({ class: handoffClass, continuity: value.continuity, from: from,
      predecessor: predecessor, reason: value.reason, successor: successor });
    if (handoffClass === "B") {
      handoff.ensureSuccessor(prepared.handoffId, function (ref) {
        return reserveSuccessor(ref, source, prepared.handoffId);
      });
    }
    var cutover = handoff.cutover(prepared.handoffId);
    var checkpoint = handoff.checkpoint(prepared.handoffId);
    return then(opts.handlers.rehydrate(cutover.handoff, checkpoint, cutover.token), function (rehydrated) {
      if (rehydrated !== true) throw new Error("Production handoff could not restore its bounded continuity state.");
      return then(opts.handlers.activate(cutover.handoff, cutover.token), function (activated) {
        if (activated !== true) throw new Error("Production handoff provider activation did not prove its start fence.");
        handoff.complete(prepared.handoffId, cutover.token);
        return handoff.inspect(prepared.handoffId);
      });
    });
  }

  // Continuity for a live execution, built from durable truth only. Deliberately
  // the same shape server-cross-project.js restartPacket builds for the Class A
  // restart checkpoint: the packet's binding is the canonical binding object
  // verbatim, so the continuity verifier's sameBinding check compares durable
  // truth against itself and the only thing that can fail is a binding that no
  // longer matches the execution.
  function continuityForLive(inspected, binding, objective) {
    var execution = inspected.execution;
    var authority = inspected.authority;
    var objectiveId = "objective:" + crypto.createHash("sha256")
      .update(execution.portfolioTaskId + "\0" + execution.bindingRevision, "utf8")
      .digest("hex").slice(0, 48);
    return continuity.normalizeContinuityPacket({
      schemaVersion: continuity.SCHEMA_VERSION,
      objectives: [{ objectiveId: objectiveId,
        text: String(objective || "").trim() ||
          ("Continue controlled execution " + execution.portfolioTaskId + ".") }],
      decisions: [],
      ownerRequests: [],
      tasks: [{ taskId: execution.portfolioTaskId, objectiveId: objectiveId,
        status: "running", owner: inspected.current.sessionRef }],
      bindings: [{ portfolioTaskId: binding.portfolioTaskId,
        bindingRevision: binding.bindingRevision, targetProject: binding.targetProject,
        mode: binding.mode, status: binding.status }],
      authorities: [{ authorityId: authority.authorityId, source: authority.source,
        portfolioTaskId: authority.portfolioTaskId, bindingRevision: authority.bindingRevision,
        targetProject: authority.targetProject, role: authority.role,
        actionMask: authority.actionMask }],
      executions: [{ executionId: execution.executionId, authorityId: authority.authorityId,
        source: authority.source, portfolioTaskId: execution.portfolioTaskId,
        bindingRevision: execution.bindingRevision, targetProject: execution.targetProject,
        mode: execution.mode, role: authority.role }],
      learningReferences: [],
    });
  }

  // The out-of-band entry point the Class B trigger calls. A daemon-side sweep
  // holds no predecessor capability -- the secret lives only in the execution
  // control's process memory -- so it rotates the target's incarnation to mint
  // one. That rotation is not a side effect to be tolerated, it is the fencing
  // this handoff needs: it marks the wedged incarnation start_state 'failed'
  // with failure_code 'restart_replay', so the predecessor can no longer act
  // while its work is being moved.
  //
  // Returns null when the execution is not live. That is the kernel's rule, not
  // a policy choice: activeExecutionForTarget filters to status IN
  // ('pending','running'), so a terminal execution has no rotatable target and
  // can never be handed off.
  function handoffLiveExecution(input) {
    var value = input || {};
    var from = projectIdentity.normalizeSessionRef(value.from);
    if (!from || typeof control.recoverTarget !== "function") {
      throw new Error("A live Class B handoff requires an exact source SessionRef.");
    }
    if (!find(from)) return null;
    var predecessor = control.recoverTarget(from);
    if (!predecessor) return null;
    control.markProviderStarted(predecessor);
    var inspected = control.inspect(predecessor.executionId);
    if (!inspected || !inspected.execution || !inspected.authority || !inspected.current) {
      throw new Error("A live Class B handoff requires a durable execution snapshot.");
    }
    var binding = typeof opts.canonicalBinding === "function" ?
      opts.canonicalBinding(inspected.execution.portfolioTaskId,
        inspected.execution.bindingRevision) : null;
    if (!binding) throw new Error("A live Class B handoff requires the canonical durable binding.");
    return then(handoffExecution({ class: "B", continuity: continuityForLive(inspected, binding,
      value.objective), from: from, predecessor: predecessor, reason: value.reason }),
    function (handoff) {
      return { from: from, handoff: handoff, predecessor: publicPredecessor(predecessor),
        successor: handoff && handoff.to || null };
    });
  }

  function publicPredecessor(token) {
    return { executionId: token.executionId, incarnationId: token.incarnationId,
      epoch: token.epoch, role: token.role, authorityId: token.authorityId };
  }

  return { continuityForLive: continuityForLive, handoffExecution: handoffExecution,
    handoffLiveExecution: handoffLiveExecution };
}

module.exports = { createProductionHandoffAdapter: createProductionHandoffAdapter };
