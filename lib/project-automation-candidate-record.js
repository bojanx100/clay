// Normalize candidate proposals without touching their durable lifecycle.
var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var qualification = require("./project-automation-qualification");
function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

// What makes two proposals for the same item "the same proposal". Deliberately
// excludes timestamps: a tick that changes nothing must not look like news.
function contentDigest(candidate) {
  return crypto.createHash("sha256").update(JSON.stringify([
    candidate.itemKey || "",
    candidate.itemClass || "",
    candidate.admission || "",
    candidate.policyDigest || "",
    candidate.projectRef ? candidate.projectRef.projectId : "",
    candidate.eligibility || null,
    qualification.stableReceiptIdentity(candidate.qualificationReceipt),
    candidate.safety || null,
    candidate.intent || null,
  ])).digest("hex").slice(0, 32);
}

// normalize -> { ok:true, record } | { ok:false, reason }
//
// The reason matters as much as the refusal. Every rejection here used to
// collapse into "invalid_candidate", which says the caller sent a malformed
// candidate. When the gate proposed a non-issue recipe it passed
// `qualificationReceipt: null` — a deliberate "there is no receipt for this
// recipe kind", not a malformed one — and the resulting "invalid_candidate"
// sent two separate investigations hunting for a corrupt candidate that never
// existed. Absent evidence and malformed evidence are different failures and
// now say so.
function normalize(candidate, now) {
  var value = candidate && typeof candidate === "object" ? candidate : null;
  if (!value) return { ok: false, reason: "invalid_candidate" };
  var projectRef = projectIdentity.normalizeProjectRef(value.projectRef);
  var key = String(value.candidateKey || value.itemKey || "").trim();
  if (!projectRef || !key) return { ok: false, reason: "invalid_candidate" };
  var hasReceipt = Object.prototype.hasOwnProperty.call(value, "qualificationReceipt");
  var supplied = hasReceipt && value.qualificationReceipt !== null &&
    value.qualificationReceipt !== undefined;
  var qualificationReceipt = supplied ?
    qualification.normalizeReceipt(value.qualificationReceipt) : null;
  // Still fail closed either way — a candidate without verifiable qualification
  // never reaches a binding — but name which of the two happened.
  if (hasReceipt && !qualificationReceipt) {
    return { ok: false, reason: supplied ?
      "qualification_receipt_malformed" : "qualification_receipt_required" };
  }
  var record = {
    candidateKey: key,
    itemKey: value.itemKey || null,
    itemClass: value.itemClass || null,
    admission: value.admission || "owner_approval",
    projectRef: { projectId: projectRef.projectId },
    policyDigest: value.policyDigest || null,
    recipeId: value.recipeId || null,
    intent: value.intent ? clone(value.intent) : null,
    // Ephemeral authority from one exact scan. It is persisted only so the
    // immediately following admission can prove this record passed every
    // current fetch/recipe/gate check; it is never interpreted by age.
    eligibilityPass: typeof value.eligibilityPass === "string" &&
      value.eligibilityPass.trim() ? value.eligibilityPass.trim() : null,
    eligibility: value.eligibility && typeof value.eligibility === "object" ? {
      assignedToOwner: value.eligibility.assignedToOwner === true,
      recipeAllowsUnassigned: value.eligibility.recipeAllowsUnassigned === true,
      reason: typeof value.eligibility.reason === "string" ?
        value.eligibility.reason.trim() || null : null,
    } : null,
    qualificationReceipt: qualificationReceipt,
    // Discovery attests the conservative safety classification that the scoped
    // Coop policy will later require. Older candidates have no such evidence and
    // therefore remain owner-gated until a fresh scan replaces them.
    safety: value.safety && typeof value.safety === "object" ? clone(value.safety) : null,
    status: "pending",
    firstSeenAt: now,
    lastSeenAt: now,
    seenCount: 1,
  };
  record.digest = contentDigest(record);
  return { ok: true, record: record };
}

// Which status survives a re-proposal.
//   admitted / owner_declined -> a decision already happened; keep it.
//   owner_approved            -> the owner said yes; a fresh scan may admit it.
//   awaiting_owner            -> only while the policy still needs an owner. If
//                               the project now auto-admits this class, waiting
//                               is stale and the record returns to pending;
//                               otherwise it would never surface again.
function stickyStatus(existing, incoming) {
  var status = existing.status;
  if (status === "admitted" || status === "owner_declined") return status;
  // Work a legacy session is already running must not be re-proposed as new,
  // or the cutover would duplicate exactly what it adopted.
  if (status === "legacy_running") return status;
  if (status === "owner_approved") return status;
  if (status === "awaiting_owner") {
    return incoming.admission === "auto" ? "pending" : "awaiting_owner";
  }
  return "pending";
}

// A legacy awaiting-owner record represents a proposal that never reached a
// binding. If a later scan independently qualifies the same item for automatic
// admission, keeping that obsolete owner gate would strand the work forever.
// This is deliberately narrower than the historical-record guard below:
// admitted work and any record with an owner decision retain their original
// receipt-less lifecycle until their own typed binding supplies terminal proof.
function canRevalidateLegacyAwaitingOwner(existing, incoming) {
  return !!(existing && incoming &&
    existing.status === "awaiting_owner" &&
    !existing.qualificationReceipt &&
    !existing.binding &&
    !existing.ownerDecision &&
    incoming.admission === "auto" &&
    incoming.qualificationReceipt);
}

module.exports = { contentDigest: contentDigest, normalize: normalize,
  stickyStatus: stickyStatus, canRevalidateLegacyAwaitingOwner: canRevalidateLegacyAwaitingOwner };
