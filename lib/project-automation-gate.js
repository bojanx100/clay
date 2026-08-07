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

var crypto = require("crypto");
var path = require("path");
var config = require("./config");
var leadModeModule = require("./lead-mode");
var policyModule = require("./project-automation-policy");
var authority = require("./project-automation-authority");
var claimLeases = require("./automation-claim-leases");
var automationAudit = require("./project-automation-audit");
var projectIdentity = require("./project-identity");
var fs = require("fs");

// Zero by default: policy is re-read for every decision. A cached policy can
// only ever be wrong in the permissive direction (the owner tightened it and
// we had not noticed), and the read is a handful of small JSON files, so the
// cache is not worth the window. A positive TTL remains available for tests.
var DEFAULT_POLICY_TTL_MS = 0;
var DEFAULT_CLAIM_TTL_MS = 900000;

function claimKeyFor(itemKey) {
  return "launch:" + String(itemKey || "");
}

// --- Holder identity and adoption ---------------------------------------------
//
// Two requirements pull in opposite directions:
//   * concurrent processes must NEVER share an identity, or one process's
//     reconciliation can renew or release another's live work;
//   * a restarted process must still be able to take back its own in-flight
//     work, or every restart risks a duplicate launch.
//
// A per-daemon-variant id satisfies the second and fails the first (a
// replacement daemon overlaps its predecessor). A time-based grace is a
// heuristic, not an invariant. So identity is per PROCESS, and re-adoption is
// decided by EVIDENCE: a claim may be taken over only when it has expired, or
// when the holding process is provably gone. `process.kill(pid, 0)` answers
// that on the same machine, which is exactly the scope that shares CLAY_HOME.
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to another user — still alive.
    if (e && e.code === "EPERM") return true;
    if (e && e.code === "ESRCH") return false;
    // Anything else is unproven, and unproven must mean "assume alive" so
    // adoption can never steal live work.
    return true;
  }
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
  // Unique per process. Restart adoption does not rely on reusing an
  // identity; it relies on proving the previous holder is gone.
  var holderPid = Number.isInteger(opts.holderPid) && opts.holderPid > 0 ? opts.holderPid : process.pid;
  var isHolderAlive = opts.isHolderAlive || processIsAlive;
  var holder = opts.holder ||
    ("project-automation:" + (slug || "unknown") + ":" + holderPid + ":" + crypto.randomUUID());

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

  var auditFailureLogged = false;

  // A decision that executes without leaving a record defeats the point of the
  // cutover, so an audit failure is logged (once, to avoid flooding a tick)
  // rather than being swallowed by a discarded return value.
  function record(decision) {
    if (decision && decision.audit) {
      var written = audit.append(decision.audit);
      if (written && written.ok !== true && !auditFailureLogged) {
        auditFailureLogged = true;
        console.error("[automation-gate] audit unavailable (" + written.reason +
          "); decisions are executing unrecorded for project " + (slug || "?"));
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
      holderPid: holderPid,
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
      var freed = leases.release({ projectRef: projectRef, key: claimKeyFor(itemKey), holder: holder });
      if (freed && freed.ok !== true) {
        // Not fatal — the lease still expires — but until then the item is
        // pinned for work nobody is doing, so say so rather than swallow it.
        console.error("[automation-gate] could not release claim for " + itemKey +
          " (" + freed.reason + "); it stays held until the lease expires");
      }
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

  // Re-checked immediately before an irreversible step. The gate verdict and
  // the actual launch are not atomic: between them the process can pause long
  // enough for the lease to lapse and another holder to take the item.
  // A read-only check would still leave a window: the lease could lapse
  // between the check and the launch. Renewing instead makes the check a
  // FENCE — it only succeeds while the lease is provably ours, and it pushes
  // expiry a full TTL past this instant, so the launch cannot straddle it.
  function holdsClaim(itemKey) {
    var projectRef = resolveProjectRef();
    if (!projectRef || !itemKey) return false;
    var renewed = leases.renew({
      projectRef: projectRef, key: claimKeyFor(itemKey), holder: holder, ttlMs: claimTtlMs,
    });
    if (renewed.ok) return true;
    // Fail closed on a busy or conflicted store: unproven is not held.
    return false;
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
    // With Lead mode off this automation holds no claims, so there is nothing
    // to adopt or release — and sweeping here would let a Lead-mode-OFF
    // project touch shared claim state on behalf of a Lead-mode-ON one.
    if (readLeadMode() !== true) return { ok: true, adopted: 0, released: 0, reclaimed: 0, failures: [], skipped: "lead_mode_off" };
    var projectRef = resolveProjectRef();
    if (!projectRef) return { ok: false, reason: "invalid_project_ref" };
    // The per-tick entry point, and therefore the natural place to drop a
    // cached policy so a tightened policy takes effect on the next tick.
    refresh();

    var failures = [];
    var swept = leases.sweep();
    if (swept && swept.ok !== true) failures.push({ op: "sweep", key: null, reason: swept.reason });

    var active = {};
    var list = activeItemKeys || [];
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i]) active[claimKeyFor(list[i])] = true;
    }

    var adopted = 0;
    var released = 0;
    var reclaimed = 0;
    var foreign = 0;
    var timestamp = now();
    var held = leases.list();
    var settled = {};

    for (var j = 0; j < held.length; j++) {
      var lease = held[j];
      if (lease.projectId !== projectRef.projectId) continue;
      if (lease.key.indexOf("launch:") !== 0) continue;
      var mine = lease.holder === holder;

      if (!active[lease.key]) {
        // Not our work and not ours to judge: another process may be running
        // it right now. Only our own orphans are released.
        if (mine && leases.release({ projectRef: projectRef, key: lease.key, holder: holder }).ok) {
          released++;
          settled[lease.key] = true;
        } else if (mine) {
          failures.push({ op: "release", key: lease.key, reason: "release_failed" });
        }
        continue;
      }

      if (mine) {
        var renewed = leases.renew({
          projectRef: projectRef, key: lease.key, holder: holder, ttlMs: claimTtlMs,
        });
        if (renewed.ok) { adopted++; settled[lease.key] = true; continue; }
        // The lease can lapse between listing and renewing. Falling through to
        // the re-acquire pass below is the point — leaving it "seen" would
        // leave running work unclaimed for another daemon to launch.
        failures.push({ op: "renew", key: lease.key, reason: renewed.reason });
        continue;
      }

      // Ours by work, someone else's by claim: adopt only on evidence that the
      // holder is gone. A live sibling keeps it.
      var takenOver = leases.adopt({
        projectRef: projectRef, key: lease.key, holder: holder,
        holderPid: holderPid, ttlMs: claimTtlMs,
      }, isHolderAlive);
      if (takenOver.ok) { adopted++; settled[lease.key] = true; }
      else if (takenOver.reason === "held") foreign++;
      else failures.push({ op: "adopt", key: lease.key, reason: takenOver.reason });
      if (takenOver.ok || takenOver.reason === "held") settled[lease.key] = true;
    }

    // Work that is still running but has no live claim at all — a long
    // restart, or a renew that lost its race above. This is the case that
    // actually causes duplicate launches, so it is never skipped.
    var activeKeys = Object.keys(active);
    for (i = 0; i < activeKeys.length; i++) {
      if (settled[activeKeys[i]]) continue;
      var retaken = leases.adopt({
        projectRef: projectRef, key: activeKeys[i], holder: holder,
        holderPid: holderPid, ttlMs: claimTtlMs,
      }, isHolderAlive);
      if (retaken.ok) reclaimed++;
      else if (retaken.reason === "held") foreign++;
      else failures.push({ op: "reclaim", key: activeKeys[i], reason: retaken.reason });
    }

    var written = audit.append({
      type: "project_automation_reconcile",
      adopted: adopted,
      released: released,
      reclaimed: reclaimed,
      foreign: foreign,
      failed: failures.length,
      projectId: projectRef.projectId,
      leadMode: true,
      at: timestamp,
    });
    if (written && written.ok !== true) {
      console.error("[automation-gate] reconciliation audit failed (" + written.reason +
        ") for project " + (slug || "?"));
      failures.push({ op: "audit", key: null, reason: written.reason });
    }
    if (failures.length) {
      console.error("[automation-gate] reconciliation left " + failures.length +
        " operation(s) unresolved for project " + (slug || "?") + ": " +
        failures[0].op + " " + failures[0].key + " (" + failures[0].reason + ")");
    }
    return {
      ok: failures.length === 0,
      reason: failures.length ? "claim_operations_failed" : undefined,
      adopted: adopted, released: released, reclaimed: reclaimed,
      foreign: foreign, failures: failures,
    };
  }

  // Re-checked immediately before an irreversible step. The gate verdict and
  // the actual launch are not atomic: between them the process can pause long
  // enough for the lease to lapse and another holder to take the item.
  // A read-only check would still leave a window: the lease could lapse
  // between the check and the launch. Renewing instead makes the check a
  // FENCE — it only succeeds while the lease is provably ours, and it pushes
  // expiry a full TTL past this instant, so the launch cannot straddle it.
  function holdsClaim(itemKey) {
    var projectRef = resolveProjectRef();
    if (!projectRef || !itemKey) return false;
    var renewed = leases.renew({
      projectRef: projectRef, key: claimKeyFor(itemKey), holder: holder, ttlMs: claimTtlMs,
    });
    if (renewed.ok) return true;
    // Fail closed on a busy or conflicted store: unproven is not held.
    return false;
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
  return {
    audit: audit,
    claimKeyFor: claimKeyFor,
    evaluateDiscovery: evaluateDiscovery,
    evaluateExternal: evaluateExternal,
    evaluateLaunch: evaluateLaunch,
    holder: holder,
    holdsClaim: holdsClaim,
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
