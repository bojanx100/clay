// project-automation-concurrency.js - How much automatic work is in flight, and
// how many slots are free right now.
//
// The launcher's `recipe.launch.defaultLimit` caps how many sessions START PER
// TICK, not how many are ACTIVE. Ten ticks of a limit-of-ten therefore leaves a
// hundred concurrent sessions running, which is not a concurrency policy at all.
// The canonical policy is a SAFE CONCURRENCY LEVEL that refills as workers
// finish: hold N in flight, and when one completes, exactly one slot frees.
//
// Two populations occupy slots, because under Coop the project controller does
// not launch directly — it proposes a candidate, admission turns it into a typed
// cross-project execution binding, and the target project's coordinator runs it:
//
//   1. legacy live auto-launched sessions (pre-cutover, draining on their own)
//   2. admitted candidates whose binding is not yet terminal
//
// Counting only one of them makes the limit meaningless: during the cutover both
// shapes are running at once, and the same item can appear as both — so the
// union is deduplicated by item key.
//
// FAIL CLOSED. Every unknown is counted as IN FLIGHT, never as a free slot. An
// unreadable binding, a throwing reader, a missing reader, a malformed candidate
// record: all occupy capacity. The one known historical shape is a pre-receipt
// admitted record with no binding at all: it cannot prove a Coop worker exists,
// while a genuine legacy worker is counted directly from the session manager.
// An unreadable candidate store reports ok:false with available 0 so the caller
// launches NOTHING, rather than reading corruption as "the system is idle" and
// starting unbounded work. The asymmetry is deliberate — under-launching costs
// latency, over-launching is the session storm this module exists to prevent.

var projectIdentity = require("./project-identity");
var automationIdentity = require("./project-automation-identity");

// A binding in one of these statuses is finished. THIS is what frees a slot and
// lets the next item backfill. `deleted` is terminal for capacity purposes: no
// worker is running against a deleted binding, whatever the binding store's own
// currency rules say about revision reuse.
var TERMINAL_BINDING_STATUSES = {
  completed: true,
  failed: true,
  superseded: true,
  deleted: true,
  // `unrouted` means the reservation was RELEASED because no task was ever
  // created — portfolio-execution-bindings keeps it out of CURRENT_STATUSES for
  // exactly that reason. So we do not merely fail to prove a worker stopped: we
  // have positive proof one never started, and holding a slot for it would leak
  // capacity permanently. A routing failure must cost a retry, never a slot.
  unrouted: true,
};

// Explicitly live. Anything that is neither live nor terminal (null, "", an
// unrecognised status, `unavailable`) still counts as in flight, because we
// cannot prove a worker stopped.
var LIVE_BINDING_STATUSES = { active: true, pending: true };
var SNAPSHOT_BINDING_STATUSES = {
  unrouted: true, pending: true, active: true, unavailable: true, deleted: true,
  completed: true, failed: true, superseded: true, cancelled: true,
  needs_input: true,
};

var LEGACY_KEY_PREFIX = "launch:";

// The candidate store prefixes legacy adoption keys with "launch:", while a live
// session carries the bare item key. Without stripping it the SAME item would be
// counted twice and silently halve the effective limit.
function normalizeItemKey(value) {
  var key = typeof value === "string" ? value.trim() : "";
  if (!key) return "";
  if (key.indexOf(LEGACY_KEY_PREFIX) === 0) return key.slice(LEGACY_KEY_PREFIX.length);
  return key;
}

function createConcurrencyLimiter(options) {
  var opts = options || {};
  var sm = opts.sm || null;
  // Absent (not supplied at all) means this project has no candidate
  // population — a legacy-only project. That is a configuration fact, not a
  // read failure, so it contributes zero rather than blocking automation
  // forever. A store that IS supplied but cannot be read fails closed.
  var candidates = opts.candidates || null;
  var getBinding = typeof opts.getBinding === "function" ? opts.getBinding : null;
  // The canonical binding-store list distinguishes a legacy record with no
  // pointer from a crash after a binding was committed.
  var getBindings = typeof opts.getBindings === "function" ? opts.getBindings : null;
  var getLimit = typeof opts.getLimit === "function" ? opts.getLimit : null;
  var now = typeof opts.now === "function" ? opts.now : Date.now;

  // A live auto-launched session is real, running capacity even when we cannot
  // attribute it to an item. Attribution failure must not make it invisible, so
  // it gets a synthetic per-session key: it still occupies a slot, and it simply
  // cannot deduplicate against a candidate.
  function collectLiveSessionKeys() {
    var keys = [];
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") {
      return { ok: true, keys: keys };
    }
    var index = 0;
    try {
      sm.sessions.forEach(function (session) {
        index++;
        var tl = session && session.taskLauncher;
        if (!tl || tl.autoLaunch !== true) return;
        if (tl.workflowCompleted) return;
        if (session.hidden) return;
        var key = normalizeItemKey(tl.automationClaimKey || tl.itemKey || tl.prKey);
        if (!key) key = "session:" + (session.storageId || session.id || index);
        keys.push(key);
      });
    } catch (e) {
      return { ok: false, reason: "session_scan_failed" };
    }
    return { ok: true, keys: keys };
  }

  // A pre-receipt record with no binding can be a durable migration remnant,
  // but it can also be a crash after a typed binding was committed and before
  // its candidate pointer was persisted. Only the canonical binding snapshot
  // distinguishes those cases; real direct legacy sessions are counted above.
  function isLegacyUnboundCandidate(candidate) {
    var projectRef = candidate && candidate.projectRef;
    return !!candidate && candidate.status === "admitted" &&
      !candidate.qualificationReceipt &&
      (candidate.binding === undefined || candidate.binding === null) &&
      typeof candidate.candidateKey === "string" && candidate.candidateKey.trim() &&
      typeof candidate.itemKey === "string" && candidate.itemKey.trim() &&
      projectRef && typeof projectRef.projectId === "string" && projectRef.projectId.trim() &&
      typeof candidate.policyDigest === "string" && candidate.policyDigest.trim() &&
      typeof candidate.recipeId === "string" && candidate.recipeId.trim() &&
      candidate.intent && typeof candidate.intent === "object";
  }

  // A binding is committed before its target coordinator starts. With a
  // complete, validated snapshot, absence of this candidate's deterministic
  // binding proves that this exact pre-receipt/no-pointer record is not a
  // cross-project worker. Any unavailable, malformed, or duplicate snapshot
  // evidence stays fail-closed and continues to occupy capacity.
  function legacyUnboundOccupiesSlot(candidate) {
    if (!getBindings) return true;
    var snapshot;
    try { snapshot = getBindings(); } catch (e) { return true; }
    if (!Array.isArray(snapshot)) return true;
    var seen = Object.create(null);
    var projectRef = projectIdentity.normalizeProjectRef(candidate && candidate.projectRef);
    var taskId = automationIdentity.portfolioTaskIdFor(candidate);
    if (!projectRef || !taskId) return true;
    for (var i = 0; i < snapshot.length; i++) {
      var binding = snapshot[i];
      var target = projectIdentity.normalizeProjectRef(binding && binding.targetProject);
      if (!binding || !projectIdentity.isTaskId(binding.portfolioTaskId) ||
          !Number.isInteger(binding.bindingRevision) || binding.bindingRevision < 1 ||
          !target || !SNAPSHOT_BINDING_STATUSES[binding.status]) return true;
      var key = binding.portfolioTaskId + ":" + binding.bindingRevision;
      if (seen[key]) return true;
      seen[key] = true;
      if (binding.portfolioTaskId !== taskId || target.projectId !== projectRef.projectId) continue;
      if (!TERMINAL_BINDING_STATUSES[binding.status]) return true;
    }
    // A complete snapshot has either only terminal matches or no match; both
    // prove that no current typed execution is consuming this candidate's slot.
    return false;
  }

  // The single fail-closed decision: does this admitted candidate still hold a
  // slot? Only a provably terminal binding — or the known unbound legacy shape
  // above — releases one.
  function occupiesSlot(candidate) {
    if (isLegacyUnboundCandidate(candidate)) return legacyUnboundOccupiesSlot(candidate);
    var binding = candidate && candidate.binding;
    if (!binding || typeof binding !== "object" || !binding.portfolioTaskId) return true;
    if (!getBinding) return true;
    var record = null;
    try {
      record = getBinding(binding.portfolioTaskId, binding.bindingRevision);
    } catch (e) {
      return true;
    }
    if (!record || typeof record !== "object") return true;
    var status = typeof record.status === "string" ? record.status : "";
    if (TERMINAL_BINDING_STATUSES[status] === true) return false;
    if (LIVE_BINDING_STATUSES[status] === true) return true;
    return true;
  }

  function collectAdmittedKeys() {
    if (!candidates) return { ok: true, keys: [] };
    if (typeof candidates.pending !== "function") {
      return { ok: false, reason: "candidate_store_unreadable" };
    }
    var result = null;
    try {
      result = candidates.pending({ statuses: ["admitted"] });
    } catch (e) {
      return { ok: false, reason: "candidate_store_threw" };
    }
    if (!result || result.ok !== true) {
      return { ok: false, reason: (result && result.reason) || "candidate_store_unreadable" };
    }
    if (!Array.isArray(result.candidates)) {
      return { ok: false, reason: "malformed_candidates" };
    }
    var keys = [];
    for (var i = 0; i < result.candidates.length; i++) {
      var candidate = result.candidates[i] || {};
      if (!occupiesSlot(candidate)) continue;
      var key = normalizeItemKey(candidate.itemKey || candidate.candidateKey);
      if (!key) key = "candidate:" + i;
      keys.push(key);
    }
    return { ok: true, keys: keys };
  }

  // inFlight() -> { ok:true, count, items } | { ok:false, reason, count }
  function inFlight() {
    var live = collectLiveSessionKeys();
    if (!live.ok) return { ok: false, reason: live.reason, count: 0 };
    var admitted = collectAdmittedKeys();
    if (!admitted.ok) {
      // The live count is still honest and worth reporting, but the caller must
      // treat the whole reading as unusable and launch nothing.
      return { ok: false, reason: admitted.reason, count: live.keys.length };
    }
    // Object.create(null) so an item key of "__proto__" or "constructor" cannot
    // be mistaken for an already-seen entry and silently freed.
    var seen = Object.create(null);
    var items = [];
    var all = live.keys.concat(admitted.keys);
    for (var i = 0; i < all.length; i++) {
      if (seen[all[i]] === true) continue;
      seen[all[i]] = true;
      items.push(all[i]);
    }
    return { ok: true, count: items.length, items: items, checkedAt: now() };
  }

  function readLimit() {
    if (!getLimit) return { ok: false, reason: "invalid_limit" };
    var value = null;
    try {
      value = getLimit();
    } catch (e) {
      return { ok: false, reason: "limit_unreadable" };
    }
    if (typeof value !== "number" || !isFinite(value) || value < 0) {
      return { ok: false, reason: "invalid_limit" };
    }
    return { ok: true, limit: Math.floor(value) };
  }

  // slots() -> { ok:true, available, limit, inFlight } | { ok:false, reason, available:0 }
  //
  // available is never negative: an over-subscribed system (in flight above the
  // limit, e.g. after the limit is lowered) reports 0 free slots and drains.
  function slots() {
    var flight = inFlight();
    if (!flight.ok) {
      return {
        ok: false, reason: flight.reason, available: 0, limit: 0, inFlight: flight.count,
      };
    }
    var limit = readLimit();
    if (!limit.ok) {
      return {
        ok: false, reason: limit.reason, available: 0, limit: 0, inFlight: flight.count,
      };
    }
    return {
      ok: true,
      available: Math.max(0, limit.limit - flight.count),
      limit: limit.limit,
      inFlight: flight.count,
      items: flight.items,
      checkedAt: flight.checkedAt,
    };
  }

  return {
    inFlight: inFlight,
    slots: slots,
  };
}

module.exports = {
  LIVE_BINDING_STATUSES: LIVE_BINDING_STATUSES,
  TERMINAL_BINDING_STATUSES: TERMINAL_BINDING_STATUSES,
  createConcurrencyLimiter: createConcurrencyLimiter,
  normalizeItemKey: normalizeItemKey,
};
