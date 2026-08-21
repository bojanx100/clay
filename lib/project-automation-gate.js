// project-automation-gate.js - The single call project automation makes before
// it does anything, and the boundary that makes Coop the only launcher.
//
//   lead-mode                    -> is Coop in charge at all?
//   project-automation-policy    -> what does THIS project's own policy allow?
//   project-automation-authority -> the pure decision
//   project-automation-audit     -> the record that makes it checkable
//
// THE ARCHITECTURE, AND WHY IT IS THIS SHAPE.
//
// An earlier version of this cutover let project automation keep launching so
// long as it held a claim, and grew a bespoke lease/fencing protocol to make
// that safe against crashes, restarts and concurrent daemons. Successive
// reviews kept finding the same class of defect in it, because a second
// independent claim authority standing next to Clay's existing one is a
// distributed-consensus problem that nothing here actually needs to solve.
//
// Clay already HAS a durable, typed, idempotent claim authority:
// portfolio-execution-bindings, reached through the canonical ProjectRef
// execution path. Coop reserves a binding for a portfolio task exactly once,
// and the target project's coordinator executes it. So the right boundary is
// not "let automation launch carefully" — it is:
//
//   Lead mode ON  -> project automation is DISCOVERY AND PROPOSAL ONLY. It may
//                    read its own recipes and policy and emit a candidate. It
//                    may not start a session, mutate launch state, or grant an
//                    external-action directive. Coop admits and dedupes the
//                    candidate through the typed binding; the project
//                    coordinator runs it.
//   Lead mode OFF -> byte-for-byte legacy behavior. No policy is read and no
//                    decision can change an outcome (roadmap §1.1).
//
// With that, this module holds no locks and owns no claims. There is exactly
// one writer for launch authority, and it is Coop.

var leadModeModule = require("./lead-mode");
var policyModule = require("./project-automation-policy");
var authority = require("./project-automation-authority");
var automationAudit = require("./project-automation-audit");
var projectIdentity = require("./project-identity");
var scopedAutonomy = require("./coop-scoped-autonomy-policy");

// Policy is re-read for every decision. A cached policy can only ever be wrong
// in the permissive direction — the owner tightened it and we had not noticed —
// and the read is a handful of small JSON files.
var DEFAULT_POLICY_TTL_MS = 0;

// Coop's canonical binding is the claim under this architecture, and a binding
// does not expire on a timer. When the pure authority asks "is a claim held?",
// the honest answer for an attested binding is simply yes, so the synthetic
// claim is stamped far enough ahead that it cannot be read as lapsed.
var ATTESTED_CLAIM_MS = 86400000;

// Candidates and audit records name an item the same way the rest of the
// subsystem does.
function candidateKeyFor(itemKey) {
  return "launch:" + String(itemKey || "");
}

function createAutomationGate(options) {
  var opts = options || {};
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var now = opts.now || Date.now;
  var policyTtlMs = Number.isInteger(opts.policyTtlMs) && opts.policyTtlMs >= 0 ?
    opts.policyTtlMs : DEFAULT_POLICY_TTL_MS;
  var loadPolicy = opts.loadPolicy || policyModule.loadProjectAutomationPolicy;
  var audit = opts.audit || automationAudit.createAutomationAudit({ slug: slug, now: now });
  // Read fresh on every decision: the owner can flip Lead mode without a
  // daemon restart, and a cached kill switch is not a kill switch.
  var readLeadMode = opts.getLeadMode || function () {
    return leadModeModule.getLeadMode({});
  };
  // Where candidates go. Coop consumes these and is the only party that may
  // turn one into a binding. It returns { ok } so a failed handoff cannot be
  // reported as a successful proposal.
  var emitCandidate = opts.emitCandidate || null;
  // Reads a committed binding, so external authorization can be PROVEN rather
  // than inferred from the shape of whatever the caller passed in.
  var readBinding = opts.getExecutionBinding ||
    (opts.crossProject && typeof opts.crossProject.getExecutionBinding === "function"
      ? function (taskId, revision) { return opts.crossProject.getExecutionBinding(taskId, revision); }
      : null);

  var cachedPolicy = null;
  var cachedPolicyAt = 0;

  function resolveProjectRef() {
    return projectIdentity.normalizeProjectRef(
      typeof opts.getProjectRef === "function" ? opts.getProjectRef() : opts.projectRef);
  }

  function currentPolicy() {
    var timestamp = now();
    if (cachedPolicy && policyTtlMs > 0 && (timestamp - cachedPolicyAt) < policyTtlMs) {
      return cachedPolicy;
    }
    var projectRef = resolveProjectRef();
    if (!projectRef) {
      cachedPolicy = { ok: false, reason: "invalid_project_ref", projectRef: null };
    } else {
      cachedPolicy = loadPolicy({ cwd: cwd, projectRef: projectRef });
    }
    cachedPolicyAt = timestamp;
    return cachedPolicy;
  }

  function refresh() {
    cachedPolicy = null;
    cachedPolicyAt = 0;
    return currentPolicy();
  }

  function policyState() {
    var loaded = currentPolicy();
    if (!loaded || loaded.ok !== true) {
      return {
        ok: false, reason: (loaded && loaded.reason) || "policy_unavailable",
        digest: null, derived: null,
      };
    }
    return { ok: true, reason: null, digest: loaded.policy.digest, derived: loaded.policy.derived };
  }

  var auditFailureLogged = false;

  // A decision that acts without leaving a record defeats the point of the
  // cutover, so an audit failure is logged rather than swallowed by a
  // discarded return value.
  // A proposal whose handoff did not persist, rendered as a typed denial so no
  // caller can mistake it for success.
  function withFailedHandoff(proposal, reason) {
    return {
      decision: authority.DENY,
      reason: reason,
      requiresApproval: proposal.requiresApproval === true,
      candidate: null,
      handoffFailed: true,
      audit: Object.assign({}, proposal.audit, {
        decision: authority.DENY, reason: reason, handoffFailed: true,
      }),
    };
  }

  function record(decision) {
    if (decision && decision.audit) {
      var written = audit.append(decision.audit);
      if (written && written.ok !== true && !auditFailureLogged) {
        auditFailureLogged = true;
        console.error("[automation-gate] audit unavailable (" + written.reason +
          "); decisions are proceeding unrecorded for project " + (slug || "?"));
      } else if (written && written.ok === true) {
        auditFailureLogged = false;
      }
      decision.auditPersisted = !!(written && written.ok === true);
    }
    return decision;
  }

  function baseInput(action, extra) {
    // Lead mode OFF must be a true no-op: the authority short-circuits before
    // it reads policy, so loading one here would add per-tick filesystem work
    // to a path the additive-only rule says must be unchanged.
    var leadMode = readLeadMode() === true;
    var loaded = leadMode ? currentPolicy() : null;
    var input = {
      leadMode: leadMode,
      action: action,
      policy: loaded && loaded.ok ? loaded.policy : null,
      policyError: !leadMode ? null :
        (loaded && loaded.ok ? null : (loaded && loaded.reason) || "policy_unavailable"),
      projectRef: resolveProjectRef(),
      holder: "coop",
      now: now(),
    };
    if (extra) {
      var keys = Object.keys(extra);
      for (var i = 0; i < keys.length; i++) input[keys[i]] = extra[keys[i]];
    }
    return input;
  }

  // Discovery survives the cutover untouched: a scan neither claims nor
  // mutates anything, and surfacing work is the role automation keeps.
  function evaluateDiscovery(context) {
    return record(authority.decideAutomation(baseInput("discover", {
      itemKey: (context && context.recipeId) || null,
    })));
  }

  // evaluateLaunch -> { decision, reason, requiresApproval, candidate, audit }
  //
  // Under Lead mode ON this NEVER returns "execute". The strongest outcome is
  // "propose": a candidate handed to Coop, which admits and dedupes it exactly
  // once through the canonical ProjectRef binding. Project automation does not
  // launch, so there is no claim to hold and no race to lose.
  //
  // The project's own policy still decides WHAT may be proposed and HOW. A
  // class its own policy makes autonomous is proposed for automatic admission;
  // feature and ambiguous capability work is proposed owner-gated. That
  // distinction rides on the candidate and is enforced at admission.
  function evaluateLaunch(request) {
    var req = request || {};
    // `recipeType` carries the recipe's own declared scope (filter.type) so
    // classification reads the same evidence the policy's autonomy derivation
    // does. Without it a bug-scoped launcher's items classify as ambiguous and
    // the project's own `bug: autonomous` grant can never be reached.
    var itemClass = req.itemClass ||
      authority.classifyAutomationItem(req.item, req.recipeKind, req.recipeType);
    var input = baseInput("launch", {
      itemClass: itemClass,
      itemKey: req.itemKey,
      approval: req.approval || null,
      // Proof from the fetch layer that this is the owner's own board work.
      // Absent means unproven, and the authority refuses unproven ownership.
      assignedToOwner: req.assignedToOwner === true,
      // Kept separate from ownership: an explicit `assigned: "any"` recipe
      // permits unassigned work to reach this project's policy decision only.
      recipeAllowsUnassigned: req.recipeAllowsUnassigned === true,
      // The question being asked is "would Coop be allowed to admit this?",
      // and Coop's canonical binding IS the claim. Supplying it keeps the pure
      // authority's reasons meaningful (policy_autonomous vs
      // owner_approval_required) instead of collapsing everything to
      // "claim_required".
      claim: { held: true, holder: "coop", expiresAt: now() + ATTESTED_CLAIM_MS },
    });
    var decided = authority.decideAutomation(input);

    // Lead OFF is the legacy pass-through, returned untouched.
    if (!input.leadMode) return record(decided);

    // Anything not denied becomes a candidate. Whether it may be admitted
    // automatically is the project's own policy decision, carried through.
    if (decided.decision === authority.DENY) return record(decided);
    var autoAdmit = decided.reason === "policy_autonomous";
    var candidate = {
      itemKey: req.itemKey || null,
      candidateKey: candidateKeyFor(req.itemKey),
      itemClass: itemClass,
      admission: autoAdmit ? "auto" : "owner_approval",
      projectRef: resolveProjectRef(),
      policyDigest: (input.policy && input.policy.digest) || null,
      recipeId: (req.intent && req.intent.recipeId) || null,
      intent: req.intent || null,
      eligibility: {
        assignedToOwner: input.assignedToOwner === true,
        recipeAllowsUnassigned: input.recipeAllowsUnassigned === true,
        reason: req.eligibilityReason || null,
      },
      // Exact scan evidence, not a timestamp. Admission accepts it only when
      // the caller presents the same unguessable pass generated for this scan.
      eligibilityPass: req.eligibilityPass || null,
      // This is not an owner decision. It is a conservative discovery-time
      // fact bundle, bound into the candidate digest and rechecked at the
      // Coop-side admission boundary before a scoped policy can apply.
      safety: scopedAutonomy.assessCandidateSafety({
        title: (req.intent && req.intent.title) || (req.item && req.item.title),
        body: (req.item && req.item.body) || (req.intent && req.intent.body),
        destructive: req.destructive === true,
        selfModifying: req.selfModifying === true,
        controlPlane: req.controlPlane === true,
        securitySensitive: req.securitySensitive === true,
        crossProject: req.crossProject === true,
        materialScopeChange: req.materialScopeChange === true,
      }),
      at: input.now,
    };
    var proposal = {
      decision: authority.PROPOSE,
      reason: "proposed_to_coop",
      requiresApproval: candidate.admission === "owner_approval",
      candidate: candidate,
      audit: Object.assign({}, decided.audit, {
        decision: authority.PROPOSE,
        reason: "proposed_to_coop",
        admission: candidate.admission,
        policyReason: decided.reason,
      }),
    };
    // (4) A proposal is only a proposal if the handoff PERSISTED. Reporting
    // proposed_to_coop after delivery threw — or after the audit write failed —
    // claims work was handed over when no durable record of it exists anywhere.
    if (!emitCandidate) {
      return record(withFailedHandoff(proposal, "candidate_sink_unavailable"));
    }
    var delivered;
    try {
      delivered = emitCandidate(candidate);
    } catch (e) {
      delivered = { ok: false, reason: "candidate_delivery_threw", error: e && e.message };
    }
    if (!delivered || delivered.ok !== true) {
      return record(withFailedHandoff(proposal,
        (delivered && delivered.reason) || "candidate_not_persisted"));
    }
    var written = record(proposal);
    if (written.auditPersisted === false) {
      // The candidate landed but the decision is unrecorded. The work is not
      // lost, so this is not a denial — but it must not read as a clean
      // proposal either.
      written.reason = "proposed_unaudited";
      written.auditFailed = true;
    }
    return written;
  }

  // Externally visible or destructive authority. Under Lead mode ON a project
  // controller can never grant this on its own: it requires a canonical
  // execution binding for the work AND the project coordinator's completion
  // evidence, neither of which this side can attest. Without that
  // authorization it denies, whatever the local policy says.
  // verifyAuthorization -> { ok } | { ok:false, reason }
  //
  // Shape is not provenance. Accepting any { portfolioTaskId, bindingRevision }
  // meant a fabricated task id plus a completion record and an approval could
  // authorize a merge — the exact authority this cutover exists to withhold. So
  // the binding is FETCHED and checked: it must exist, be committed (active,
  // not merely reserved), and target THIS project. Anything else is refused.
  function verifyAuthorization(authorization, projectRef) {
    if (!authorization || typeof authorization !== "object") {
      return { ok: false, reason: "coop_authorization_required" };
    }
    var taskId = authorization.portfolioTaskId;
    var revision = authorization.bindingRevision;
    if (typeof taskId !== "string" || !taskId.trim()) {
      return { ok: false, reason: "coop_authorization_required" };
    }
    if (!Number.isInteger(revision) || revision < 1) {
      return { ok: false, reason: "coop_authorization_required" };
    }
    if (!projectRef) return { ok: false, reason: "invalid_project_ref" };
    // Without a reader we cannot prove anything, and an unprovable authorization
    // must not be honored.
    if (!readBinding) return { ok: false, reason: "coop_authorization_unverifiable" };
    var binding;
    try {
      binding = readBinding(taskId, revision);
    } catch (e) {
      return { ok: false, reason: "coop_authorization_unverifiable" };
    }
    if (!binding) return { ok: false, reason: "coop_authorization_unknown" };
    // "pending" is reserved-but-not-committed: Coop has not actually taken
    // responsibility for this work yet.
    if (binding.status !== "active") {
      return { ok: false, reason: "coop_authorization_not_committed" };
    }
    var target = binding.targetProject || {};
    if (target.projectId !== projectRef.projectId) {
      return { ok: false, reason: "coop_authorization_foreign_project" };
    }
    return { ok: true, binding: binding };
  }

  // Externally visible or destructive authority. Under Lead mode ON a project
  // controller can never grant this on its own: it requires a COMMITTED
  // canonical execution binding for this project's work, which only Coop can
  // create, plus the project coordinator's completion evidence.
  function evaluateExternal(request) {
    var req = request || {};
    var leadMode = readLeadMode() === true;
    var projectRef = resolveProjectRef();
    var verdict = leadMode ?
      verifyAuthorization(req.coopAuthorization, projectRef) : { ok: true };
    var input = baseInput("external", {
      externalKind: req.externalKind || null,
      itemKey: req.itemKey || null,
      itemClass: req.itemClass || null,
      // The proven binding IS the claim. Nothing local can synthesize one.
      claim: leadMode && verdict.ok ?
        { held: true, holder: "coop", expiresAt: now() + ATTESTED_CLAIM_MS } : null,
      completion: req.completion || null,
      approval: req.approval || null,
      // The owner-triggered carve-out survives only on authentic provenance.
      ownerTriggered: req.ownerTriggered === true && (!leadMode || verdict.ok),
    });
    if (leadMode && !verdict.ok) {
      var denied = authority.decideAutomation(input);
      denied.decision = authority.DENY;
      denied.reason = verdict.reason;
      denied.requiresApproval = true;
      denied.audit = Object.assign({}, denied.audit, {
        decision: authority.DENY, reason: verdict.reason,
      });
      return record(denied);
    }
    return record(authority.decideAutomation(input));
  }

  return {
    audit: audit,
    candidateKeyFor: candidateKeyFor,
    evaluateDiscovery: evaluateDiscovery,
    evaluateExternal: evaluateExternal,
    evaluateLaunch: evaluateLaunch,
    policyState: policyState,
    verifyAuthorization: verifyAuthorization,
    refresh: refresh,
  };
}

module.exports = {
  DEFAULT_POLICY_TTL_MS: DEFAULT_POLICY_TTL_MS,
  candidateKeyFor: candidateKeyFor,
  createAutomationGate: createAutomationGate,
};
