// Production handoff adapter. It creates a Class B successor through the
// SessionManager before the durable handoff is allowed to cut over.

var crypto = require("crypto");
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

  return { handoffExecution: handoffExecution };
}

module.exports = { createProductionHandoffAdapter: createProductionHandoffAdapter };
