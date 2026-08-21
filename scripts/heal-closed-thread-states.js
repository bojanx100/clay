#!/usr/bin/env node
// Idempotent repair for Threads that were closed without being retired.
//
// threadState is the primary lifecycle axis and the owner's Threads rail filters
// on it alone. Two paths used to close a record by assigning topic.status
// directly and never advancing threadState, so the record read as "closed"
// everywhere that looks at status while still rendering as a live Thread row --
// permanently, because the bulk-closure sweep only ever selects status "open".
//
// The defect itself is fixed in lib (coop-thread-lifecycle.applyRecordStatus,
// used by coop-topic-closure and coop-topic-index-migrations). This script only
// repairs records already written to disk before that fix landed.
//
//   node scripts/heal-closed-thread-states.js                     # dry run, live store
//   node scripts/heal-closed-thread-states.js --apply --reconcile-requests --owner-approved
//                                                               # repair the live store
//   node scripts/heal-closed-thread-states.js --file /tmp/copy.json --apply
//
// Options:
//   --apply                  actually write; without it nothing is modified
//   --file <path>            target a copy instead of the live Lead store
//   --include-handed-off     also complete status=closed/threadState=handed_off
//                            records (see below -- off by default)
//   --default-outcome <o>    closeOutcome for records with no classification
//                            (implemented_resolved | not_pursuing)
//   --reconcile-requests     settle owner requests before healing their records
//                            (live store only; required for live --apply)
//   --owner-approved         confirm the owner approved this live-state edit
//
// WHAT IT REPAIRS. Any record with status "closed" whose threadState still keeps
// it in the Threads rail -- "exploring" or "parked". The rail filter is a
// denylist (it drops handed_off and closed and keeps everything else), so those
// two states are exactly the leaking set, not just "exploring".
//
// A status=closed/threadState=handed_off record is inconsistent too, but it is
// already filtered out of the rail and completing its close is a judgement about
// real linked work, so it needs --include-handed-off rather than riding along.
//
// hidden:true WARNING. closeOutcome "not_pursuing" sets hidden:true
// (coop-thread-lifecycle), which suppresses the row ENTIRELY rather than filing
// it under Done. Records classified not_pursuing below will disappear from the
// owner's surface, not move to Done. Confirm that is wanted before --apply.
//
// OWNER REQUESTS. Closing a topic is supposed to settle the owner requests it
// resolved (coop-topic-management.reconcileClosedTopicRequests). The status-only
// closes skipped that, so linked requests may still be unsettled. Live
// --apply requires --reconcile-requests. Settlement happens first and is
// idempotent, then the exact previewed records are healed. A failure or crash
// leaves the topic as the durable retry marker; rerun the same command
// immediately to completion. The option is refused against --file, because a
// rehearsal on a copy must not write the live ledger.
//
// It cannot run archiveCompletedCoopTopicSessions: that is a callback the server
// injects into its request context, unreachable from a standalone process. These
// records are already status=closed, so no archive obligation is created here --
// the one that was missed was missed at close time. Session archiving for them
// has to happen in-process if the owner wants it.
//
// Dry runs and copy rehearsals are safe while Clay is up. Live --apply refuses
// to run until the daemon is stopped, then writes through the same locked,
// compare-and-swap topic store used by the daemon.
var path = require("path");
var fs = require("fs");
var crypto = require("crypto");
var config = require("../lib/config");
var topicIndexModule = require("../lib/coop-topic-index");
var threadLifecycle = require("../lib/coop-thread-lifecycle");
var threadClosureRepair = require("../lib/coop-thread-closure-repair");
var ownerRequestsModule = require("../lib/coop-owner-requests");

var DEFAULT_FILE = path.join(config.CONFIG_DIR, "lead", "coop-topic-index.json");

// Owner-supplied classification for the records damaged before the fix landed
// (ingress 586). The repair itself is generic -- anything not listed here takes
// --default-outcome -- but closeOutcome is the one field a status-only close
// never recorded, so it cannot be inferred from the record and has to be stated.
var CLASSIFICATION = {
  // Delivered.
  "auto-387581bf19bf34013b9d6312": "implemented_resolved",
  "auto-ee42dbcb8e5610e4f924f213": "implemented_resolved",
  "auto-b708ce3119b0ca4ff54496a5": "implemented_resolved",
  "auto-f0c398039a2b35c000caff20": "implemented_resolved",
  "auto-3512f05562f0dad3536a76ad": "implemented_resolved",
  "auto-e0380cb0dbf698f53b67cd62": "implemented_resolved",
  // Superseded, or no discrete deliverable. NOTE: not_pursuing sets hidden:true.
  "auto-96ccb456649fd54217800168": "not_pursuing",
  "owner-efcb42e5ac25b6704cd72764": "not_pursuing",
  "auto-bd0261a728d1841610336a0c": "not_pursuing",
  "auto-c32e28cb96c48d15743b2dae": "not_pursuing",
  "auto-0ebfb6a7372e675e6d62c87c": "not_pursuing",
  "auto-5cf6d62aab5455ec1dbc39b3": "not_pursuing",
  "auto-708de5690c825718659e6951": "not_pursuing",
  "auto-5fe6b68529acc3b4f731e903": "not_pursuing",
  "auto-e66c3f11d0f90aae960bd130": "not_pursuing",
};

function flag(name) { return process.argv.indexOf("--" + name) !== -1; }

function option(name, fallback) {
  var at = process.argv.indexOf("--" + name);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

var APPLY = flag("apply");
var FILE = option("file", DEFAULT_FILE);
var INCLUDE_HANDED_OFF = flag("include-handed-off");
var RECONCILE_REQUESTS = flag("reconcile-requests");
var OWNER_APPROVED = flag("owner-approved");
var DEFAULT_OUTCOME = option("default-outcome",
  threadLifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED);

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function canonicalPath(file) {
  var resolved = path.resolve(file);
  try { return fs.realpathSync(resolved); }
  catch (e) {
    try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); }
    catch (e2) { return resolved; }
  }
}

function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function snapshotLiveStores() {
  var snapshotDir = path.join(config.CONFIG_DIR, "repair-snapshots",
    "thread-closure-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"));
  fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  var sources = [DEFAULT_FILE,
    path.join(config.CONFIG_DIR, "lead", "coop-owner-requests.json")];
  var files = [];
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    var entry = { source: source, existed: fs.existsSync(source) };
    if (entry.existed) {
      entry.snapshot = path.join(snapshotDir, path.basename(source));
      fs.copyFileSync(source, entry.snapshot);
      entry.sha256 = fileHash(source);
      if (fileHash(entry.snapshot) !== entry.sha256) fail("snapshot verification failed: " + source);
    }
    files.push(entry);
  }
  var manifest = path.join(snapshotDir, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ createdAt: Date.now(), files: files }, null, 2) + "\n",
    { mode: 0o600 });
  process.stdout.write("Verified snapshot: " + manifest + "\n");
  process.stdout.write("Rollback: stop Clay, restore each manifest snapshot to its source; " +
    "remove sources marked existed:false.\n\n");
  return manifest;
}

var LIVE_FILE = canonicalPath(DEFAULT_FILE);
var TARGET_FILE = canonicalPath(FILE);
var LIVE_TARGET = TARGET_FILE === LIVE_FILE;

if (DEFAULT_OUTCOME !== threadLifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED &&
    DEFAULT_OUTCOME !== threadLifecycle.CLOSE_OUTCOMES.NOT_PURSUING) {
  fail("--default-outcome must be implemented_resolved or not_pursuing");
}
if (RECONCILE_REQUESTS && !LIVE_TARGET) {
  fail("--reconcile-requests targets the live owner-request ledger and cannot be " +
    "combined with --file; rehearse on the copy without it.");
}
if (RECONCILE_REQUESTS && !APPLY) {
  fail("--reconcile-requests requires --apply; dry runs preview topic repair candidates only");
}
if (APPLY && LIVE_TARGET && !RECONCILE_REQUESTS) {
  fail("live --apply requires --reconcile-requests so owner requests settle before repair");
}
if (APPLY && LIVE_TARGET && !OWNER_APPROVED) {
  fail("live --apply requires --owner-approved after the owner reviews the dry run");
}
if (APPLY && LIVE_TARGET) {
  var daemonConfig = config.loadConfig();
  if (config.isPidAlive(daemonConfig && daemonConfig.pid)) {
    fail("stop the Clay daemon before live --apply so an older writer cannot recreate the damage");
  }
}

var index = topicIndexModule.createTopicIndex({ file: FILE });
var healOptions = {
  closeOutcomes: CLASSIFICATION,
  closeOutcome: DEFAULT_OUTCOME,
  includeHandedOff: INCLUDE_HANDED_OFF,
};

process.stdout.write("store: " + FILE + "\n");
process.stdout.write("mode:  " + (APPLY ? "APPLY" : "dry run") + "\n\n");

// Dry run heals a throwaway deep copy of the loaded state, so nothing -- not
// even the in-memory cache the store would later commit -- is touched.
var report;
if (APPLY && RECONCILE_REQUESTS) {
  process.stdout.write("Settling owner requests linked to repair candidates:\n");
  report = threadClosureRepair.healWithOwnerRequests(index,
    ownerRequestsModule.getDefaultOwnerRequests(), Object.assign({}, healOptions, {
      beforeWrite: function () { snapshotLiveStores(); },
    }));
  if (!report.ok) fail("heal failed for " + (report.threadId || "unknown") + ": " +
    (report.reason || report.code || "unknown_error"));
  for (var sr = 0; sr < report.settlements.length; sr++) {
    var settlement = report.settlements[sr];
    process.stdout.write("  " + settlement.threadId + " -> settled=" +
      settlement.result.settled.length + " preserved=" +
      settlement.result.preserved.length + " changed=" + !!settlement.result.changed + "\n");
  }
  if (!report.settlements.length) process.stdout.write("  no repair candidates\n");
  process.stdout.write("\n");
} else if (APPLY) {
  report = index.healClosedThreadStates(healOptions);
  if (!report.ok) fail("heal failed: " + (report.code || "unknown_error"));
} else {
  var copy = JSON.parse(JSON.stringify(index.load()));
  report = threadClosureRepair.healClosedThreadStates(copy,
    Object.assign({ now: Date.now }, healOptions));
}

if (!report.healed.length) {
  process.stdout.write("Nothing to repair: no status=closed record has a live threadState.\n");
} else {
  process.stdout.write((APPLY ? "Repaired " : "Would repair ") +
    report.healed.length + " record(s):\n");
  for (var i = 0; i < report.healed.length; i++) {
    var entry = report.healed[i];
    process.stdout.write("  " + entry.threadId +
      "  threadState " + entry.before.threadState + " -> " + entry.after.threadState +
      "  closeOutcome " + String(entry.before.closeOutcome) + " -> " + entry.after.closeOutcome +
      (entry.after.hidden ? "  hidden:true (row suppressed, NOT filed under Done)" : "") + "\n");
  }
  var hiddenCount = report.healed.filter(function (e) { return e.after.hidden; }).length;
  if (hiddenCount) {
    process.stdout.write("\n" + hiddenCount + " of these are not_pursuing and set hidden:true: " +
      "their rows disappear from the owner's surface entirely rather than moving to Done.\n");
  }
}

if (report.skippedHandedOff && report.skippedHandedOff.length) {
  process.stdout.write("\nSkipped " + report.skippedHandedOff.length +
    " status=closed/threadState=handed_off record(s) -- inconsistent but not " +
    "leaking into the rail. Re-run with --include-handed-off to complete them:\n");
  for (var s = 0; s < report.skippedHandedOff.length; s++) {
    process.stdout.write("  " + report.skippedHandedOff[s] + "\n");
  }
}

if (!APPLY) {
  process.stdout.write("\nDry run: nothing written. " + (LIVE_TARGET
    ? "Stop Clay, review the candidates, then re-run with --apply " +
      "--reconcile-requests --owner-approved.\n"
    : "Re-run the same --file target with --apply.\n"));
}
