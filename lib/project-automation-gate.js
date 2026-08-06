// project-automation-gate.js - Composes the four cutover primitives into the
// single call the project runtime makes before automation does anything.
//
//   lead-mode                  -> is Coop in charge at all?
//   project-automation-policy  -> what does THIS project's own policy allow?
//   automation-claim-leases    -> does exactly one actor hold this work?
//   project-automation-authority -> the pure decision
//   project-automation-audit   -> the record that makes it checkable
//
// Why a claim is acquired here rather than inside the authority module: the
// authority is pure and must stay fixture-testable, but a claim is a durable
// side effect. So the gate probes the decision with no claim, and only when
// the probe says "this would run, it just needs a claim" does it actually try
// to take one — otherwise a proposal would leave a lease behind for work that
// never started.
//
// THE DOUBLE-LAUNCH RULE. `acquire` returning created:false means the lease
// already existed for this holder. That is NOT permission to proceed: it means
// another tick in this same runtime already claimed the item and is presumably
// running it. Only a freshly created lease (created:true) authorizes a launch.
// This is what closes the overlapping-tick hole that the old
// check-live-session -> write-state -> start sequence had.

var leadModeModule = require("./lead-mode");
var policyModule = require("./project-automation-policy");
var authority = require("./project-automation-authority");
var claimLeases = require("./automation-claim-leases");
var automationAudit = require("./project-automation-audit");
var projectIdentity = require("./project-identity");

var DEFAULT_POLICY_TTL_MS = 30000;
var DEFAULT_CLAIM_TTL_MS = 900000;

function claimKeyFor(itemKey) {
  return "launch:" + String(itemKey || "");
}

function createAutomationGate(options) {
  var opts = options || {};
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var now = opts.now || Date.now;
  var policyTtlMs = Number.isInteger(opts.policyTtlMs) && opts.policyTtlMs >= 0 ?
    opts.policyTtlMs : DEFAULT_POLICY_TTL_MS;
  var claimTtlMs = Number.isInteger(opts.claimTtlMs) && opts.claimTtlMs > 0 ?
    opts.claimTtlMs : DEFAULT_CLAIM_TTL_MS;
  var loadPolicy = opts.loadPolicy || policyModule.loadProjectAutomationPolicy;
  var leases = opts.leases || claimLeases.createClaimLeases({ now: now });
  var audit = opts.audit || automationAudit.createAutomationAudit({ slug: slug, now: now });
  // Read fresh on every decision: the owner can flip Lead mode without a
  // daemon restart, and a cached kill switch is not a kill switch.
  var readLeadMode = opts.getLeadMode || function () {
    return leadModeModule.getLeadMode({});
  };
  // One holder identity per project runtime. Restart-safe by design: after a
  // restart the same identity can idempotently re-observe its own lease, which
  // is what lets in-flight work be adopted instead of double-started.
  var holder = opts.holder || ("project-automation:" + (slug || "unknown"));

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
      return { ok: false, reason: (loaded && loaded.reason) || "policy_unavailable", digest: null, derived: null };
    }
    return { ok: true, reason: null, digest: loaded.policy.digest, derived: loaded.policy.derived };
  }

  function record(decision) {
    if (decision && decision.audit) audit.append(decision.audit);
    return decision;
  }

  function baseInput(action, extra) {
    var loaded = currentPolicy();
    var input = {
      leadMode: readLeadMode() === true,
      action: action,
      policy: loaded && loaded.ok ? loaded.policy : null,
      policyError: loaded && loaded.ok ? null : (loaded && loaded.reason) || "policy_unavailable",
      projectRef: resolveProjectRef(),
      holder: holder,
      now: now(),
    };
    if (extra) {
      var keys = Object.keys(extra);
      for (var i = 0; i < keys.length; i++) input[keys[i]] = extra[keys[i]];
    }
    return input;
  }

  // Discovery is unconditional under the cutover — legacy automation keeps its
  // scanning role. Kept as an explicit call so the audit shows scans happened.
  function evaluateDiscovery(context) {
    return record(authority.decideAutomation(baseInput("discover", {
      itemKey: (context && context.recipeId) || null,
    })));
  }

  // evaluateLaunch -> { decision, reason, requiresApproval, lease, audit }
  //   "execute" means: you hold a fresh claim, start the work.
  //   "propose" means: hand it to Coop, do not start it.
  //   "deny"    means: do nothing.
  function evaluateLaunch(request) {
    var req = request || {};
    var itemKey = req.itemKey;
    var itemClass = req.itemClass ||
      authority.classifyAutomationItem(req.item, req.recipeKind);
    var probeInput = baseInput("launch", {
      itemClass: itemClass,
      itemKey: itemKey,
      approval: req.approval || null,
      claim: null,
    });
    var probe = authority.decideAutomation(probeInput);

    // Anything other than "blocked purely on a claim" is already final. In
    // particular a Lead-mode-off pass-through takes no lease at all, so the
    // legacy path stays byte-for-byte what it is today.
    if (probe.reason !== "claim_required") return record(probe);
    if (!itemKey) {
      return record(authority.decideAutomation(Object.assign({}, probeInput, {
        claim: null, itemKey: null,
      })));
    }

    var projectRef = resolveProjectRef();
    if (!projectRef) return record(probe);

    var acquired = leases.acquire({
      projectRef: projectRef,
      key: claimKeyFor(itemKey),
      holder: holder,
      ttlMs: claimTtlMs,
    });
    if (!acquired.ok) {
      // "held" is another holder; anything else is a store fault. Both mean we
      // must not start the work.
      return record(withReason(probe, "deny",
        acquired.reason === "held" ? "claim_held_elsewhere" : acquired.reason));
    }
    if (acquired.created !== true) {
      // Our own runtime already claimed this item on an earlier, overlapping
      // tick. Skipping here is the no-duplicate-launch guarantee.
      return record(withReason(probe, "deny", "claim_already_active"));
    }

    var decided = authority.decideAutomation(Object.assign({}, probeInput, {
      claim: { held: true, holder: holder, expiresAt: acquired.lease.expiresAt },
    }));
    // If the real decision is not "go", give the lease straight back rather
    // than parking a claim on work nobody is doing.
    if (decided.decision !== authority.EXECUTE) {
      leases.release({ projectRef: projectRef, key: claimKeyFor(itemKey), holder: holder });
    } else {
      decided.lease = acquired.lease;
    }
    return record(decided);
  }

  // A claim-store outcome, rendered in the same shape the authority returns so
  // callers and the audit see one uniform decision type. The probe's audit
  // already carries the project, class, item and policy digest; only the
  // verdict changes.
  function withReason(probe, decision, reason) {
    return {
      decision: decision,
      reason: reason,
      requiresApproval: probe.requiresApproval === true,
      audit: Object.assign({}, probe.audit, { decision: decision, reason: reason }),
    };
  }

  // Externally visible / destructive authority. The claim consulted here is
  // the SAME lease taken for the launch, which is what ties "you may comment
  // on / merge / close this" to "you are the one runner that owns this work".
  function evaluateExternal(request) {
    var req = request || {};
    var itemKey = req.itemKey;
    var projectRef = resolveProjectRef();
    var lease = projectRef && itemKey ?
      leases.get(projectRef, claimKeyFor(itemKey)) : null;
    var claim = lease ?
      { held: true, holder: lease.holder, expiresAt: lease.expiresAt } : null;
    return record(authority.decideAutomation(baseInput("external", {
      externalKind: req.externalKind || null,
      itemKey: itemKey || null,
      itemClass: req.itemClass || null,
      claim: claim,
      completion: req.completion || null,
      approval: req.approval || null,
      ownerTriggered: req.ownerTriggered === true,
    })));
  }

  function renewClaim(itemKey) {
    var projectRef = resolveProjectRef();
    if (!projectRef || !itemKey) return { ok: false, reason: "invalid_claim" };
    return leases.renew({
      projectRef: projectRef, key: claimKeyFor(itemKey), holder: holder, ttlMs: claimTtlMs,
    });
  }

  function releaseClaim(itemKey) {
    var projectRef = resolveProjectRef();
    if (!projectRef || !itemKey) return { ok: false, reason: "invalid_claim" };
    return leases.release({ projectRef: projectRef, key: claimKeyFor(itemKey), holder: holder });
  }

  // Restart migration. For each item the runtime still believes is running,
  // renew (adopt) the lease; for a claim whose work is gone, release it so the
  // item can be re-proposed instead of being pinned until the TTL lapses.
  // Leases held by a DIFFERENT holder are left strictly alone.
  function reconcileClaims(activeItemKeys) {
    var projectRef = resolveProjectRef();
    if (!projectRef) return { ok: false, reason: "invalid_project_ref" };
    var active = {};
    var list = activeItemKeys || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i]) active[claimKeyFor(list[i])] = true;
    }
    // Expired leases are already invisible to reads, but they stay on disk
    // forever unless something prunes them. Reconciliation is the natural
    // place, since it is the one path that runs on every tick.
    leases.sweep();
    var adopted = 0;
    var released = 0;
    var held = leases.list();
    for (var j = 0; j < held.length; j++) {
      var lease = held[j];
      if (lease.projectId !== projectRef.projectId || lease.holder !== holder) continue;
      if (lease.key.indexOf("launch:") !== 0) continue;
      if (active[lease.key]) {
        if (leases.renew({ projectRef: projectRef, key: lease.key, holder: holder, ttlMs: claimTtlMs }).ok) {
          adopted++;
        }
      } else if (leases.release({ projectRef: projectRef, key: lease.key, holder: holder }).ok) {
        released++;
      }
    }
    audit.append({
      type: "project_automation_reconcile",
      adopted: adopted,
      released: released,
      projectId: projectRef.projectId,
      leadMode: readLeadMode() === true,
      at: now(),
    });
    return { ok: true, adopted: adopted, released: released };
  }

  return {
    audit: audit,
    claimKeyFor: claimKeyFor,
    evaluateDiscovery: evaluateDiscovery,
    evaluateExternal: evaluateExternal,
    evaluateLaunch: evaluateLaunch,
    holder: holder,
    leases: leases,
    policyState: policyState,
    reconcileClaims: reconcileClaims,
    refresh: refresh,
    releaseClaim: releaseClaim,
    renewClaim: renewClaim,
  };
}

module.exports = {
  DEFAULT_CLAIM_TTL_MS: DEFAULT_CLAIM_TTL_MS,
  DEFAULT_POLICY_TTL_MS: DEFAULT_POLICY_TTL_MS,
  claimKeyFor: claimKeyFor,
  createAutomationGate: createAutomationGate,
};
