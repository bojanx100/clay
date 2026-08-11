// project-automation-authority.js - The single decision point that says what
// legacy project automation is allowed to do once Coop (Lead mode) owns
// routing.
//
// Background. Clay's project automation (auto-launch, the task launcher, the
// PR-review responder) historically did three things on its own initiative:
// it DISCOVERED work by scanning GitHub, it CLAIMED and LAUNCHED a session for
// that work, and — through the prompt text it hands the agent — it authorized
// EXTERNALLY VISIBLE actions (commenting on an issue, taking a PR out of
// draft, moving a board column, merging, closing). Nothing in Node ever calls
// `gh pr merge`; the authority is granted textually. That makes the injection
// of that text the real, enforceable boundary, which is why "external" is a
// first-class action here rather than a wrapper around a shell command.
//
// After the cutover, with Lead mode ON, legacy automation keeps DISCOVERY but
// loses unilateral claiming, launching and external authority. It may propose;
// Coop admits, prioritizes, dedupes and routes through the typed ProjectRef
// execution binding. The one exception is autonomy a project's OWN policy
// grants (see project-automation-policy.js) — e.g. a bug-scoped issue launcher
// keeps running bugs by itself — and even that requires a unique, unexpired
// claim lease so two ticks, two recipes or two daemons cannot double-launch.
//
// This module is PURE: no I/O, no clock, no fs. `now` and every piece of state
// are injected, so a decision is fixture-testable and byte-reproducible. The
// caller persists the returned audit record.
//
// Fail-closed is the rule everywhere: if we cannot prove an action is allowed,
// it is denied. There is deliberately no "assume it's fine" branch.

var projectIdentity = require("./project-identity");

var ACTIONS = { discover: true, launch: true, external: true };
var EXTERNAL_KINDS = { comment: true, done_workflow: true, merge: true, close: true };
var CLASSES = { bug: true, feature: true, ambiguous: true, pr_review: true };

// Decisions. "propose" is the cutover's whole point: the automation still
// surfaces the work, it just cannot act on it.
var EXECUTE = "execute";
var PROPOSE = "propose";
var DENY = "deny";

// Plain-object membership tests would let inherited keys ("constructor",
// "toString") pass an allowlist and skip a deny-by-default branch. Own-property
// only, for a module whose stated rule is that a bug must never widen authority.
function has(table, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// A work item's class decides which autonomy stance applies. Order matters:
// PR-review work is classified by its source kind, never by labels, because a
// PR carrying a "bug" label is still PR-lifecycle work and must not inherit
// bug autonomy.
//
// `recipeType` is the SCOPE THE RECIPE ITSELF DECLARES (its `filter.type`), and
// it is the same evidence project-automation-policy.deriveAutonomy reads when it
// decides a project has a bug-scoped launcher. Both sides must read it or the
// grant is unreachable, which is exactly the defect this parameter fixes: a
// launcher scoped to `type: "bug"` filters by EXCLUSION (it drops feature and
// legacy labels; `requireBugLabel` is off by default), so it legitimately
// returns bug work carrying no `bug` label. Classifying purely by labels sent
// every one of those items to "ambiguous" -> owner_approval, so a project whose
// own policy granted `bug: autonomous` could never actually admit a single item
// — the board sat idle while the candidate queue filled with owner-gated work.
//
// The recipe's declared scope is only ever a FALLBACK for an item that carries
// no decisive label of its own. A label on the item still wins, and still fails
// toward the stricter class, so this can never reclassify feature work as a bug.
function classifyAutomationItem(item, recipeKind, recipeType) {
  if (recipeKind === "pr_review" || recipeKind === "pr-review" ||
      recipeKind === "pr-reviews" || recipeKind === "prs") return "pr_review";
  var labels = (item && item.labels) || [];
  var names = {};
  for (var i = 0; i < labels.length; i++) {
    var raw = typeof labels[i] === "string" ? labels[i] : (labels[i] && labels[i].name);
    if (raw) names[String(raw).toLowerCase()] = true;
  }
  // "feature" wins over "bug" when both are present: capability work is
  // owner-gated, and a mislabeled item must fail toward the stricter class.
  if (names.feature || names.enhancement || names.legacy) return "feature";
  if (names.bug || names.defect) return "bug";
  // No decisive label. Fall back to the scope the recipe declares, mirroring
  // project-automation-policy.deriveAutonomy exactly so classification and the
  // autonomy grant cannot disagree about what "a bug-scoped launcher" means.
  var scope = typeof recipeType === "string" ? recipeType.toLowerCase() : "";
  if (scope === "bug") return "bug";
  if (scope === "feature" || scope === "legacy") return "feature";
  // An unscoped recipe tells us nothing, so this stays the "ambiguous
  // capability work" the owner gate exists for — never silently treated as a bug.
  return "ambiguous";
}

// A claim must be OURS and still valid at decision time. An expired lease is
// not a claim: that is what makes a crashed holder recoverable without ever
// letting two holders act at once.
function holdsClaim(claim, holder, now) {
  if (!claim || claim.held !== true) return false;
  if (!nonEmpty(holder) || claim.holder !== holder) return false;
  if (typeof claim.expiresAt !== "number" || !Number.isFinite(claim.expiresAt)) return false;
  return claim.expiresAt > now;
}

// Project completion evidence, mirroring lead-ledger's portfolio completion
// gate: a summary, verification, and an explicit "no escalation". Anything
// missing means the project coordinator has not actually finished, so no
// externally visible action may ride on it.
function hasCompletionEvidence(completion) {
  if (!completion || completion.status !== "completed") return false;
  if (!nonEmpty(completion.summary) || !nonEmpty(completion.verification)) return false;
  return completion.escalationRequired === "no" || completion.escalationRequired === false;
}

function approvalGranted(approval) {
  return !!(approval && approval.granted === true && nonEmpty(approval.by));
}

function auditRecord(input, decision, reason, extra) {
  var policy = input.policy || null;
  var record = {
    type: "project_automation_decision",
    action: input.action || "",
    decision: decision,
    reason: reason,
    projectId: policy && policy.projectRef ? policy.projectRef.projectId :
      (projectIdentity.normalizeProjectRef(input.projectRef) || {}).projectId || null,
    itemClass: input.itemClass || null,
    externalKind: input.externalKind || null,
    leadMode: input.leadMode === true,
    policyDigest: policy && policy.digest ? policy.digest : null,
    policyDerived: policy ? policy.derived === true : null,
    itemKey: nonEmpty(input.itemKey) ? input.itemKey : null,
    // Recorded so "why was this refused?" and "why was this eligible?" both
    // have an answer in the log, not just the reason code.
    assignedToOwner: input.assignedToOwner === true,
    at: input.now,
  };
  if (extra) {
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) record[keys[i]] = extra[keys[i]];
  }
  return record;
}

function result(input, decision, reason, requiresApproval, extra) {
  return {
    decision: decision,
    reason: reason,
    requiresApproval: requiresApproval === true,
    audit: auditRecord(input, decision, reason, extra),
  };
}

// Lead mode OFF is not a bypass we tolerate silently — it is the roadmap's
// explicit reversibility contract (CTO-ORCHESTRATOR-ROADMAP §1.1: with the
// mode off, Clay behaves exactly as it does today). It is still audited, with
// a distinct reason code, so "why did this act on its own?" always has an
// answer in the log.
function legacyDecision(input) {
  return result(input, EXECUTE, "lead_mode_off_legacy", false, { legacy: true });
}

function stanceForClass(policy, itemClass) {
  var autonomy = policy.autonomy || {};
  if (has(CLASSES, itemClass) && has(autonomy, itemClass)) return autonomy[itemClass];
  return autonomy.default || "propose";
}

// Board work must be ASSIGNED TO THE OWNER to be automatically eligible.
//
// This is an eligibility precondition, not a policy stance, so it is checked
// before any stance is consulted and no stance — not even "autonomous" — can
// satisfy it. An unassigned board item is not work the owner has taken on, and
// automatic pickup of one is indistinguishable from the automation choosing its
// own work: trialview/v2#2539 was unassigned, was proposed bug/auto, and
// produced PR #2591 that nobody had asked for.
//
// Only an explicit `true` passes. An absent or non-boolean stamp means the
// fetch layer could not PROVE ownership (an unresolvable gh login, a source
// that carries no assignees), and unproven ownership is refused.
//
// PR-review work is exempt because its class already encodes ownership: the
// pr-reviews source only ever returns PRs the owner authored or committed to,
// and that class is owner-gated by derivation regardless.
function assignmentEligible(input, itemClass) {
  if (itemClass === "pr_review") return true;
  return input.assignedToOwner === true;
}

function decideLaunch(input) {
  var policy = input.policy;
  var itemClass = has(CLASSES, input.itemClass) ? input.itemClass : "ambiguous";
  var stance = stanceForClass(policy, itemClass);

  // Before the stance, so autonomy can never reach unassigned work.
  if (!assignmentEligible(input, itemClass)) {
    return result(input, DENY, "not_assigned_to_owner", false, { stance: stance });
  }

  if (stance === "deny") {
    return result(input, DENY, "policy_denies_class", false, { stance: stance });
  }
  if (stance === "propose") {
    return result(input, PROPOSE, "policy_requires_proposal", false, { stance: stance });
  }
  if (stance === "owner_approval") {
    if (!approvalGranted(input.approval)) {
      return result(input, PROPOSE, "owner_approval_required", true, { stance: stance });
    }
    // Approved capability work still cannot skip the claim: approval says
    // "this work may run", the lease says "and only one runner has it".
    if (!holdsClaim(input.claim, input.holder, input.now)) {
      return result(input, DENY, "claim_required", true, { stance: stance });
    }
    return result(input, EXECUTE, "owner_approved", true, { stance: stance });
  }
  if (stance === "autonomous") {
    if (!holdsClaim(input.claim, input.holder, input.now)) {
      return result(input, DENY, "claim_required", false, { stance: stance });
    }
    return result(input, EXECUTE, "policy_autonomous", false, { stance: stance });
  }
  // An unrecognized stance is a policy bug, and a policy bug must never widen
  // authority.
  return result(input, DENY, "policy_malformed_stance", false, { stance: String(stance) });
}

// Externally visible or destructive actions carry three independent
// requirements, checked in a fixed order so the audit reason names the FIRST
// thing missing rather than a vague "not allowed":
//   1. the project's own policy must not forbid this action kind,
//   2. a unique unexpired claim must be held by this actor,
//   3. the project coordinator must have produced real completion evidence,
//   4. and, unless policy downgrades it to claim-only, an approval.
function decideExternal(input) {
  var policy = input.policy;
  var kind = input.externalKind;
  if (!has(EXTERNAL_KINDS, kind)) {
    return result(input, DENY, "invalid_external_kind", false, null);
  }
  var actions = policy.externalActions || {};
  var stance = has(actions, kind) ? actions[kind] : null;
  if (stance === "deny" || !stance) {
    return result(input, DENY, "policy_denies_external_action", false, { stance: stance || null });
  }
  if (!holdsClaim(input.claim, input.holder, input.now)) {
    return result(input, DENY, "claim_required", stance === "approval", { stance: stance });
  }
  // Completion evidence proves the project coordinator actually finished
  // before anything irreversible rides on it.
  //
  // The carve-out. "done_workflow" is the grant carried by the task launcher's
  // completion directive, and it is deliberately NOT filed under "comment":
  // it authorizes commenting on the issue AND taking the PR out of draft AND
  // moving the board column. Calling that a comment would understate it and
  // would let a project that permitted comments unknowingly permit board and
  // PR mutation.
  //
  // Completion evidence cannot gate it, because this grant is precisely what
  // drives the coordinator to finish — requiring the evidence first is
  // circular and would deadlock the flow the cutover promises not to block.
  // What DOES gate it is a live claim plus an explicit owner instruction, and
  // a project may still refuse it outright via externalActions.done_workflow.
  //
  // merge and close are irreversible and get no carve-out at all: they always
  // require claim + completion evidence + approval, owner-triggered or not.
  var ownerCarveOut = input.ownerTriggered === true &&
    (kind === "comment" || kind === "done_workflow") && approvalGranted(input.approval);
  if (!ownerCarveOut && !hasCompletionEvidence(input.completion)) {
    return result(input, DENY, "completion_evidence_required", stance === "approval", { stance: stance });
  }
  if (ownerCarveOut) {
    return result(input, EXECUTE, "owner_triggered_external", true,
      { stance: stance, ownerTriggered: true });
  }
  if (stance === "approval") {
    if (!approvalGranted(input.approval)) {
      return result(input, DENY, "approval_required", true, { stance: stance });
    }
    return result(input, EXECUTE, "external_action_authorized", true, { stance: stance });
  }
  if (stance === "claim") {
    return result(input, EXECUTE, "external_action_authorized", false, { stance: stance });
  }
  return result(input, DENY, "policy_malformed_stance", false, { stance: String(stance) });
}

// decideAutomation(input) -> { decision, reason, requiresApproval, audit }
//   leadMode      — Coop's kill switch (lib/lead-mode.js getLeadMode)
//   action        — "discover" | "launch" | "external"
//   externalKind  — "comment" | "merge" | "close" (required when action=external)
//   policy        — a project-automation-policy policy object, or null
//   policyError   — the loader's fail-closed reason, or null
//   itemClass     — from classifyAutomationItem, or null to fall back to the
//                   policy default
//   claim/holder  — Coop's attested canonical execution binding, and the
//                   actor it is attested for
//   completion    — the project coordinator's completion evidence
//   approval      — { granted, by, at } from the configured approval gate
//   now           — injected clock (ms)
function decideAutomation(input) {
  var request = input && typeof input === "object" ? input : {};
  var normalized = {
    leadMode: request.leadMode === true,
    action: request.action,
    externalKind: request.externalKind || null,
    policy: request.policy || null,
    policyError: request.policyError || null,
    projectRef: request.projectRef || null,
    itemClass: request.itemClass || null,
    itemKey: request.itemKey || null,
    // Tri-state on purpose: true is proof, false is proof of the opposite, and
    // anything else (absent, null, a truthy non-boolean) is "unproven" and is
    // refused by assignmentEligible.
    assignedToOwner: request.assignedToOwner === true,
    claim: request.claim || null,
    holder: request.holder || "",
    completion: request.completion || null,
    approval: request.approval || null,
    ownerTriggered: request.ownerTriggered === true,
    now: typeof request.now === "number" && Number.isFinite(request.now) ? request.now : 0,
  };

  if (!has(ACTIONS, normalized.action)) {
    return result(normalized, DENY, "invalid_action", false, null);
  }

  // The kill switch is checked before anything else so Lead-off is provably a
  // pure pass-through: no policy is loaded, no claim is consulted, nothing can
  // change behavior that exists today.
  if (!normalized.leadMode) return legacyDecision(normalized);

  // Discovery survives the cutover untouched and even survives a broken
  // policy: "may discover and propose" is the whole point, and a scan neither
  // claims nor mutates anything. Everything else needs a loadable policy.
  if (normalized.action === "discover") {
    return result(normalized, EXECUTE, "discovery_always_allowed", false, null);
  }

  if (normalized.policyError) {
    return result(normalized, DENY, normalized.policyError, false, { failClosed: true });
  }
  if (!normalized.policy) {
    return result(normalized, DENY, "policy_unavailable", false, { failClosed: true });
  }
  if (!projectIdentity.normalizeProjectRef(normalized.policy.projectRef)) {
    return result(normalized, DENY, "invalid_project_ref", false, { failClosed: true });
  }

  if (normalized.action === "launch") return decideLaunch(normalized);
  return decideExternal(normalized);
}

module.exports = {
  ACTIONS: ACTIONS,
  CLASSES: CLASSES,
  EXTERNAL_KINDS: EXTERNAL_KINDS,
  EXECUTE: EXECUTE,
  PROPOSE: PROPOSE,
  DENY: DENY,
  classifyAutomationItem: classifyAutomationItem,
  decideAutomation: decideAutomation,
  hasCompletionEvidence: hasCompletionEvidence,
  holdsClaim: holdsClaim,
};
