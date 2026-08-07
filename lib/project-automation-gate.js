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
  // turn one into a binding.
  var emitCandidate = opts.emitCandidate || null;

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
    var itemClass = req.itemClass ||
      authority.classifyAutomationItem(req.item, req.recipeKind);
    var input = baseInput("launch", {
      itemClass: itemClass,
      itemKey: req.itemKey,
      approval: req.approval || null,
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
    if (emitCandidate) {
      try {
        emitCandidate(candidate);
      } catch (e) {
        console.error("[automation-gate] candidate delivery failed:", e && e.message);
      }
    }
    return record(proposal);
  }

  // Externally visible or destructive authority. Under Lead mode ON a project
  // controller can never grant this on its own: it requires a canonical
  // execution binding for the work AND the project coordinator's completion
  // evidence, neither of which this side can attest. Without that
  // authorization it denies, whatever the local policy says.
  function evaluateExternal(request) {
    var req = request || {};
    var leadMode = readLeadMode() === true;
    var authorization = req.coopAuthorization || null;
    var authorized = !!(authorization && authorization.portfolioTaskId &&
      Number.isInteger(authorization.bindingRevision) && authorization.bindingRevision > 0);
    var input = baseInput("external", {
      externalKind: req.externalKind || null,
      itemKey: req.itemKey || null,
      itemClass: req.itemClass || null,
      // The canonical binding IS the claim under this architecture. Nothing
      // local can synthesize one.
      claim: leadMode && authorized ?
        { held: true, holder: "coop", expiresAt: now() + ATTESTED_CLAIM_MS } : null,
      completion: req.completion || null,
      approval: req.approval || null,
      ownerTriggered: req.ownerTriggered === true,
    });
    if (leadMode && !authorized) {
      var denied = authority.decideAutomation(input);
      denied.decision = authority.DENY;
      denied.reason = "coop_authorization_required";
      denied.requiresApproval = true;
      denied.audit = Object.assign({}, denied.audit, {
        decision: authority.DENY, reason: "coop_authorization_required",
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
    refresh: refresh,
  };
}

module.exports = {
  DEFAULT_POLICY_TTL_MS: DEFAULT_POLICY_TTL_MS,
  candidateKeyFor: candidateKeyFor,
  createAutomationGate: createAutomationGate,
};
