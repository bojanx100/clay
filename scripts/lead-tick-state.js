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

// `listCurrent()` is the existing accessor for exactly the statuses that hold a
// portfolio slot (CURRENT_STATUSES in lib/portfolio-execution-bindings.js).
// Completed/failed/superseded/unrouted bindings free the slot, so the tick has
// never needed them -- it was reading 314 records to act on 2.
function readBindings() {
  var bindings = require("../lib/portfolio-execution-bindings")
    .createPortfolioExecutionBindings({ reconcileOnLoad: false });
  var loadError = bindings.getLoadError();
  return {
    current: bindings.listCurrent(),
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
    var state = String((item && item.state) || "open").toLowerCase();
    if (state === "closed") dropped++;
    else kept.push(item);
  }
  return { items: kept, droppedClosed: dropped };
}

function readLeadLedger() {
  var ledger = require("../lib/lead-ledger");
  return { inFlight: ledger.inFlight() };
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
  var steps = [
    attempt("leadMode", readLeadMode),
    attempt("ownerRequests", readOwnerRequests),
    attempt("bindings", readBindings),
    attempt("looseItems", readLooseItems),
    attempt("leadLedger", readLeadLedger),
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

module.exports = { gather: gather, localMidnight: localMidnight, main: main };
