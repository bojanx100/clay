#!/usr/bin/env node
"use strict";

// One-shot state gatherer for the Lead/Coop foreground turn.
//
// Replaces the several separate `node -e` reads that step 1 of the lead-tick
// skill used to issue. Two costs are being cut, and only the second one is
// about CPU:
//
//  1. ROUND TRIPS. Each separate bash step in a turn is a full model
//     round trip. The reads themselves are 20-50ms each, so the wall clock was
//     dominated by the turn structure, not the work. One process = one trip.
//  2. CONTEXT BYTES. The old step dumped `bindings.list()` -- 314 records /
//     275KB / ~69K tokens as measured 2026-08-22 -- when only the 2 records in
//     CURRENT_STATUSES can hold a portfolio slot. Oversized state is paid for
//     twice: once in prefill, and again as a prompt-cache miss on every turn.
//
// Usage:
//   node scripts/lead-tick-state.js            # compact snapshot on stdout
//   node scripts/lead-tick-state.js --pretty   # human-readable
//   node scripts/lead-tick-state.js --refresh  # warm caches only, no snapshot
//
// `--refresh` is the background/prewarm entry point: run it off the foreground
// turn (cron, post-turn hook, or a detached spawn) so the cold session-log
// rebuild never lands inside an owner-facing turn.

var fs = require("fs");
var path = require("path");
var os = require("os");

var usageCache = require("../lib/lead-budget-usage-cache");
var leadBudget = require("../lib/lead-budget");

function localMidnight() {
  var now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

// Every source is wrapped: one unreadable input must degrade that single field,
// never abort the whole turn's state gathering.
function attempt(label, fn) {
  try {
    return { ok: true, label: label, value: fn() };
  } catch (err) {
    return { ok: false, label: label, error: String((err && err.message) || err) };
  }
}

function readOwnerRequests() {
  var ledger = require("../lib/coop-owner-requests").getDefaultOwnerRequests();
  var unanswered = ledger.unanswered();
  return unanswered.map(function (record) {
    return {
      ingressId: record.ingressId,
      seq: record.ingressSequence,
      receivedAt: record.receivedAt,
      topicRef: record.topicRef,
      requestRef: record.requestRef,
      state: record.state,
      expectsExecution: record.expectsExecution,
    };
  });
}

// Bindings cannot simply be narrowed to `listCurrent()`. Terminal bindings look
// like dead weight -- 159 completed, 74 failed, 30 superseded of 315 -- but two
// consumers need them, and dropping them fails OPEN:
//
//  * project-automation-candidates.js:78 returns
//    `already_completed_or_in_flight` for status "completed". Without terminal
//    records an already-finished issue becomes eligible and the same work gets
//    staffed twice.
//  * lead-loop.js:100 `bindingBlocksRestaff` blocks restaffing on completed /
//    superseded / cancelled / deleted for the same reason.
//
// So every record is kept and the narrowing is by FIELD. The three predicates
// that read a binding here -- validTypedBinding (lead-loop.js:71),
// bindingBlocksRestaff (:100) and latestCandidateBinding
// (candidates.js:48-57) -- between them read exactly five properties.
//
// Current records keep their full shape because `inFlightForTick` echoes the
// matched binding into its result and downstream staffing reads the rest of it;
// only terminal records, which never surface there, are thinned. Verified
// identical to the full list for both `inFlightForTick` and `leadTick` on the
// live store, at 276KB -> 67KB.
//
// Records must NOT be pre-deduped to the latest revision per task: those
// predicates fail closed on a malformed lower-revision record, so dropping one
// would turn a fail-closed `ok: false` into a fail-open `ok: true`.
// Which records may be thinned is decided by `lead-loop.bindingConsumesCapacity`
// itself, never by a status list copied into this file. Two such lists already
// exist and they DISAGREE: the store's CURRENT_STATUSES is
// {pending, active, unavailable, deleted}, while lead-loop's terminal set is
// {completed, failed, superseded, cancelled, deleted, unrouted}. So `deleted`
// holds a slot by one definition and frees it by the other, and `needs_input`
// appears in neither list yet consumes capacity and IS surfaced by
// `inFlightForTick` -- which means a copied list thinned away its `coordinator`
// and `source` while downstream staffing still needed them.
//
// Asking the authoritative predicate removes that whole class of drift, and it
// fails safe: an unknown or future status is not terminal, so it keeps its full
// shape rather than being silently stripped.
function thinnedProjection(binding) {
  return {
    portfolioTaskId: binding.portfolioTaskId,
    targetProject: binding.targetProject,
    bindingRevision: binding.bindingRevision,
    mode: binding.mode,
    status: binding.status,
  };
}

function readBindings() {
  var leadLoop = require("../lib/lead-loop");
  var bindings = require("../lib/portfolio-execution-bindings")
    .createPortfolioExecutionBindings({ reconcileOnLoad: false });
  var loadError = bindings.getLoadError();
  var all = bindings.list();
  var occupying = [];
  var typedHistory = [];
  for (var i = 0; i < all.length; i++) {
    // Full shape for anything that can hold a slot or be surfaced downstream;
    // only records that can do neither are narrowed to the five fields every
    // binding predicate reads.
    if (leadLoop.bindingConsumesCapacity(all[i])) {
      occupying.push(all[i]);
      typedHistory.push(all[i]);
    } else {
      typedHistory.push(thinnedProjection(all[i]));
    }
  }
  return {
    // Records that actually consume a portfolio slot, per lead-loop's own
    // predicate. This is a capacity view and nothing else -- never pass it
    // where completion is decided.
    occupying: occupying,
    // Every record, thinned only where provably unused. This is the
    // `portfolioBindings` input for leadTick AND the list for
    // completionEligibility.
    typedHistory: typedHistory,
    loadError: loadError ? String(loadError.message || loadError) : null,
  };
}

// `lead-backlog.collectPortfolioItems` already skips every item whose state is
// not "open" (lib/lead-backlog.js:75), and a missing state normalizes to "open"
// (line 21). So withholding closed items from the snapshot is equivalent, not a
// policy change -- it just stops paying ~60KB of context for records the
// portfolio builder discards. The dropped count is reported so a shrunken
// snapshot can never be mistaken for an empty backlog.
function readLooseItems() {
  var file = path.join(os.homedir(), ".clay", "lead", "items.json");
  var raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { items: [], droppedClosed: 0 };
  }
  var parsed = JSON.parse(raw);
  var all = Array.isArray(parsed) ? parsed : parsed && parsed.items;
  if (!Array.isArray(all)) return { items: [], droppedClosed: 0 };
  var kept = [];
  var dropped = 0;
  for (var i = 0; i < all.length; i++) {
    var item = all[i];
    var raw = item && item.state;
    // Only a genuine string state can be judged here. A non-string state (array,
    // object, number) is kept and left to downstream normalization, which throws
    // on it -- withholding it would silently convert that loud failure into an
    // item that just quietly vanished from the backlog. `String(["closed"])`
    // stringifies to "closed", so this guard matters.
    var state = typeof raw === "string" ? raw.trim().toLowerCase() : (raw == null ? "open" : null);
    if (state === "closed") dropped++;
    else kept.push(item);
  }
  return { items: kept, droppedClosed: dropped };
}

function readLeadLedger() {
  var ledger = require("../lib/lead-ledger");
  return { inFlight: ledger.inFlight() };
}

// The runtime slices above are not a historical work ledger. This file is the
// durable inventory of Coop-created/touched sessions, including terminal and
// missing entries that the owner-facing session query intentionally hides.
function readHistoricalLedger(file) {
  var ledgerFile = file || path.join(os.homedir(), ".clay", "lead", "coop-session-ledger.json");
  var parsed = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error("historical Coop session ledger has no entries array");
  }
  var classified = require("../lib/lead-ledger").classifyHistoricalLedger(parsed.entries);
  return {
    scanned: classified.scanned,
    counts: classified.counts,
    unresolved: classified.unresolved,
  };
}

function readProviderHealth() {
  var config = require("../lib/config");
  return require("../lib/lead-health").readHealthSnapshot(config.recoveryLogPath());
}

function readLeadMode() {
  var users = require("../lib/users");
  var data = users.loadUsers();
  var owner = data.users[0];
  return {
    userId: owner && owner.id,
    leadMode: owner ? users.getLeadMode(owner.id) : false,
  };
}

function readBudget(dayStartAt) {
  var refreshed = usageCache.refresh({});
  var daily = leadBudget.buildDailyBudget(refreshed.sessions, {
    dayStartAt: dayStartAt,
    vendorCostRank: { codex: 1, claude: 2 },
  });
  return {
    burnRate: leadBudget.formatBurnRate(daily),
    pressure: daily.pressure,
    dataAvailable: daily.dataAvailable,
    byVendor: daily.byVendor,
    unattributedSessions: daily.unattributedSessions,
    cache: refreshed.stats,
  };
}

function gather(options) {
  var opts = options || {};
  var dayStartAt = typeof opts.dayStartAt === "number" ? opts.dayStartAt : localMidnight();
  var startedAt = Date.now();

  // Independent sources, so nothing here needs to be ordered. They are all
  // synchronous file reads: in one process the kernel already services them
  // back-to-back with no round trip between, which is where the old sequential
  // shape actually lost its time.
  var bindingStep = attempt("bindings", readBindings);
  var steps = [
    attempt("leadMode", readLeadMode),
    attempt("ownerRequests", readOwnerRequests),
    bindingStep,
    attempt("looseItems", readLooseItems),
    attempt("leadLedger", readLeadLedger),
    attempt("historicalLedger", readHistoricalLedger),
    attempt("providerHealth", readProviderHealth),
    attempt("budget", function () { return readBudget(dayStartAt); }),
  ];

  var snapshot = { type: "lead_tick_state", dayStartAt: dayStartAt, errors: [] };
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (step.ok) snapshot[step.label] = step.value;
    else {
      snapshot[step.label] = null;
      snapshot.errors.push({ source: step.label, error: step.error });
    }
  }
  snapshot.elapsedMs = Date.now() - startedAt;
  return snapshot;
}

function main(argv) {
  var args = argv || [];
  var pretty = args.indexOf("--pretty") !== -1;

  if (args.indexOf("--refresh") !== -1) {
    var started = Date.now();
    var refreshed = usageCache.refresh({});
    process.stdout.write(JSON.stringify({
      type: "lead_tick_state_refresh",
      elapsedMs: Date.now() - started,
      stats: refreshed.stats,
      cacheFile: refreshed.cacheFile,
      saved: refreshed.saved,
    }) + "\n");
    return 0;
  }

  var snapshot = gather({});
  process.stdout.write(JSON.stringify(snapshot, null, pretty ? 1 : 0) + "\n");
  return snapshot.errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

// readBindings/readLooseItems are exported so tests can drive the REAL
// projection instead of a hand-built copy of it. A previous test built its own
// fixtures and therefore could not catch that `needs_input` was being thinned.
module.exports = {
  gather: gather,
  localMidnight: localMidnight,
  main: main,
  readBindings: readBindings,
  readLooseItems: readLooseItems,
  readHistoricalLedger: readHistoricalLedger,
  thinnedProjection: thinnedProjection,
};
