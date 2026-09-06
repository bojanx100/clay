// Immutable evidence of an actual primitive launch, separate from the mutable
// current candidate receipt. Historical eligibility never supplies freshness.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var identity = require("./project-identity");

var SCHEMA = "clay.primitive_launch_evidence";
var verifiedProofs = new WeakMap();

function normalizeProof(value) {
  var keys = ["sessionRef", "itemKey", "receiptDigest", "policyDigest", "recipeDigest", "itemUrl", "createdAt", "evidenceDigest"];
  if (!value || Object.keys(value).sort().join(",") !== keys.sort().join(",")) return null;
  var ref = identity.normalizeSessionRef(value.sessionRef);
  if (!ref || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
      typeof value.itemKey !== "string" || typeof value.itemUrl !== "string") return null;
  for (var i = 0; i < 4; i++) {
    if (!/^[a-f0-9]{64}$/.test(value[["receiptDigest", "policyDigest", "recipeDigest", "evidenceDigest"][i]])) return null;
  }
  return { sessionRef: ref, itemKey: value.itemKey, receiptDigest: value.receiptDigest,
    policyDigest: value.policyDigest, recipeDigest: value.recipeDigest,
    itemUrl: value.itemUrl, createdAt: value.createdAt, evidenceDigest: value.evidenceDigest };
}

// Only proofs minted from a real session and the immutable record can relax
// the previous-receipt age check. A serialized or caller-built lookalike cannot.
function verifyProof(proof, input) {
  var bound = proof && verifiedProofs.get(proof);
  if (!bound) return { ok: false, reason: "historical_launch_proof_unverified" };
  var result = verifyRecord(bound.record, Object.assign({}, bound.input, input));
  if (!result.ok || JSON.stringify(result.proof) !== JSON.stringify(proof)) {
    return { ok: false, reason: "historical_launch_proof_changed" };
  }
  return result;
}

function normalizeRecord(value) {
  var qualification = require("./project-automation-qualification");
  var ref = identity.normalizeSessionRef(value && value.sessionRef);
  var receipt = qualification.normalizeReceipt(value && value.qualificationReceipt);
  if (!ref || !receipt || receipt.historicalLaunch || ref.projectId !== receipt.projectRef.projectId ||
      receipt.classification.admission !== "auto" ||
      receipt.coordinator.reasons.indexOf("existing_primitive_in_flight") !== -1) return null;
  return { sessionRef: ref, qualificationReceipt: receipt };
}

function verifyRecord(record, input) {
  var policyModule = require("./project-automation-policy");
  var value = normalizeRecord(record);
  var opts = input || {};
  var session = opts.session;
  var tl = session && session.taskLauncher;
  var projectRef = identity.normalizeProjectRef(opts.projectRef);
  var storageId = session && (session.storageId || session.cliSessionId);
  var recipe = opts.recipe;
  if (!value || !projectRef || value.sessionRef.projectId !== projectRef.projectId ||
      value.sessionRef.sessionStorageId !== storageId || !session || session.hidden ||
      !tl || tl.autoLaunch !== true || tl.workflowCompleted ||
      tl.executionCompletionReported || tl.executionCompletionPending ||
      !Number.isSafeInteger(session.createdAt) || session.createdAt > opts.now ||
      !Number.isSafeInteger(opts.now)) return { ok: false, reason: "historical_launch_session_mismatch" };
  var receipt = value.qualificationReceipt;
  if (!recipe || recipe.id !== receipt.recipe.id || tl.recipeId !== recipe.id ||
      policyModule.recipeDigest(recipe) !== receipt.recipe.digest ||
      receipt.item.key !== opts.itemKey || Number(tl.itemNumber) !== receipt.item.number ||
      tl.itemUrl !== "https://github.com/" + receipt.item.repo + "/issues/" + receipt.item.number ||
      (tl.itemKey && tl.itemKey !== receipt.item.key) ||
      (tl.automationClaimKey && tl.automationClaimKey !== receipt.item.key) || tl.prKey) {
    return { ok: false, reason: "historical_launch_identity_mismatch" };
  }
  // Use the real session's launch clock solely to verify the old receipt.
  // receiptFor still validates freshly fetched issue facts with today's clock.
  var verified = require("./project-automation-qualification").verifyReceipt(receipt, {
    policy: opts.policy, now: session.createdAt,
  });
  if (!verified.ok) return verified;
  var proof = Object.freeze({
    sessionRef: value.sessionRef, itemKey: receipt.item.key,
    receiptDigest: receipt.digest, policyDigest: receipt.policy.digest,
    recipeDigest: receipt.recipe.digest, itemUrl: tl.itemUrl, createdAt: session.createdAt,
    evidenceDigest: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  });
  verifiedProofs.set(proof, { record: value, input: opts });
  return { ok: true, receipt: verified.receipt, proof: proof };
}

function createLaunchEvidenceStore(options) {
  var opts = options || {};
  var dir = opts.dir || path.join(opts.cwd, ".clay", "tasks", "primitive-launch-evidence");
  function fileFor(ref) {
    var normalized = identity.normalizeSessionRef(ref);
    if (!normalized) return null;
    var key = crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    return path.join(dir, key + ".json");
  }
  function read(ref) {
    var file = fileFor(ref);
    if (!file) return null;
    try {
      var data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || data.schema !== SCHEMA || data.version !== 1) return null;
      var record = normalizeRecord(data.record);
      return record && JSON.stringify(record.sessionRef) === JSON.stringify(identity.normalizeSessionRef(ref))
        ? record : null;
    } catch (error) { return null; }
  }
  function retain(record) {
    var value = normalizeRecord(record);
    if (!value) return { ok: false, reason: "historical_launch_evidence_invalid" };
    var file = fileFor(value.sessionRef);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // One immutable file per session prevents concurrent imports or launches
      // from replacing earlier evidence or losing another session's record.
      fs.writeFileSync(file, JSON.stringify({ schema: SCHEMA, version: 1, record: value }, null, 2) + "\n",
        { mode: 0o600, flag: "wx" });
      return { ok: true, created: true };
    } catch (error) {
      if (error.code === "EEXIST") {
        var prior = read(value.sessionRef);
        return prior && prior.qualificationReceipt.digest === value.qualificationReceipt.digest
          ? { ok: true, created: false }
          : { ok: false, reason: "historical_launch_evidence_conflict" };
      }
      return { ok: false, reason: "historical_launch_evidence_write_failed" };
    }
  }
  function verify(input) {
    var session = input && input.session;
    var ref = { projectId: input && input.projectRef && input.projectRef.projectId,
      sessionStorageId: session && (session.storageId || session.cliSessionId) };
    var record = read(ref);
    return record ? verifyRecord(record, input) : { ok: false, reason: "historical_launch_evidence_missing" };
  }
  return { fileFor: fileFor, retain: retain, verify: verify };
}

module.exports = { SCHEMA: SCHEMA, normalizeRecord: normalizeRecord,
  verifyRecord: verifyRecord, verifyProof: verifyProof, normalizeProof: normalizeProof,
  createLaunchEvidenceStore: createLaunchEvidenceStore };
