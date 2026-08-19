#!/usr/bin/env node

// Takes a consistent, single-file snapshot of the Coop control store, and
// audits the hand-made `.bak` files that predate this script.
//
// Why this exists
// ---------------
// `~/.clay/lead/coop-control.sqlite` runs in WAL mode. A backup that copies
// only the main database file therefore captures whatever was last
// checkpointed, which can be many hours behind the committed state. Every
// hand-made `coop-control.sqlite.pre-*.bak` in `~/.clay/lead/` was made that
// way, and every one of them is stale. Restoring from one looks like a
// successful rollback while silently discarding committed rows.
//
// Why VACUUM INTO
// ---------------
// `VACUUM INTO` runs inside a single read transaction, so the file it writes is
// a transactionally consistent image of the source *including every committed
// WAL frame*, even while the daemon keeps writing. It emits one self-contained
// file with no `-wal`/`-shm` sidecars, so there is no second and third file for
// a future operator to forget -- which is exactly how the existing `.bak` set
// went wrong. It needs no dependency beyond the `node:sqlite` the store already
// uses, and the identical statement works from the `sqlite3` CLI if Node is
// unavailable.
//
// The alternatives were rejected:
//   * The online backup API restarts its copy whenever the source is written
//     mid-copy, so under a busy writer it can retry indefinitely. VACUUM INTO's
//     read-snapshot semantics are simpler and sufficient here.
//   * Copying the `.sqlite` + `-wal` + `-shm` trio is NOT atomic: the three
//     copies are separate syscall sequences, and a commit or checkpoint landing
//     between them yields a torn set. It is a valid way to *read* an already
//     quiesced directory (that is how the pre-reconcile forensics were done),
//     but it is not a safe way to take a backup from under a live writer.
//
// Usage
// -----
//   node scripts/snapshot-control-store.js --label pre-orphan-reconcile
//   node scripts/snapshot-control-store.js --audit
//   node scripts/snapshot-control-store.js --source <db> --out <file>
//
// The source is opened read-only and is never modified.

var fs = require("fs");
var os = require("os");
var path = require("path");

var sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (loadError) {
  sqlite = null;
}

var DatabaseSync = sqlite ? sqlite.DatabaseSync : null;

// Resolved the same way lib/config.js resolves it, but without importing that
// module: requiring it performs directory creation and a legacy-home rename,
// and a backup tool must not have side effects on the tree it is protecting.
function clayHome() {
  if (process.env.CLAY_HOME) return process.env.CLAY_HOME;
  if (process.env.CLAUDE_RELAY_HOME) return process.env.CLAUDE_RELAY_HOME;
  return path.join(os.homedir(), ".clay");
}

function defaultSourcePath() {
  return path.join(clayHome(), "lead", "coop-control.sqlite");
}

function defaultSnapshotDir() {
  return path.join(clayHome(), "control-store-snapshots");
}

function stampFromDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function safeLabel(value) {
  var label = String(value == null ? "manual" : value).trim();
  label = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return label || "manual";
}

function openReadOnly(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function countExecutions(db) {
  return db.prepare("SELECT COUNT(*) AS total FROM coop_control_executions").get().total;
}

function tableNames(db) {
  var rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  var names = [];
  for (var i = 0; i < rows.length; i++) names.push(rows[i].name);
  return names;
}

// Reads a database file in isolation, i.e. exactly what a main-file-only `.bak`
// preserves. The copy goes to a scratch path so the original is never opened
// in a way that could create sidecars beside it.
function readMainFileOnly(dbPath) {
  var scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-bak-probe-"));
  var probePath = path.join(scratchDir, "probe.sqlite");
  try {
    fs.copyFileSync(dbPath, probePath);
    var db = openReadOnly(probePath);
    try {
      return { ok: true, executions: countExecutions(db) };
    } finally {
      db.close();
    }
  } catch (probeError) {
    return { ok: false, error: probeError.message };
  } finally {
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (cleanupError) {}
  }
}

function assertAvailable() {
  if (!DatabaseSync) {
    throw new Error("node:sqlite is unavailable; this script requires a Node runtime that provides it.");
  }
}

// Takes the snapshot and verifies it before returning. Exported so the test
// suite exercises the real code path rather than a re-implementation.
function snapshotControlStore(options) {
  assertAvailable();
  var opts = options || {};
  var sourcePath = opts.source || defaultSourcePath();
  if (!fs.existsSync(sourcePath)) {
    throw new Error("Control store not found: " + sourcePath);
  }

  var destPath = opts.out;
  if (!destPath) {
    var dir = opts.dir || defaultSnapshotDir();
    var stamp = stampFromDate(opts.now || new Date());
    destPath = path.join(dir, "coop-control." + safeLabel(opts.label) + "." + stamp + ".sqlite");
  }
  destPath = path.resolve(destPath);

  // Refuse to breed another file beside the live store. New snapshots belong in
  // their own directory where nothing mistakes them for store internals.
  if (path.dirname(destPath) === path.dirname(path.resolve(sourcePath))) {
    throw new Error("Refusing to write a snapshot into the live store directory: " + path.dirname(destPath));
  }
  if (fs.existsSync(destPath)) {
    throw new Error("Snapshot destination already exists: " + destPath);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  var source = openReadOnly(sourcePath);
  var journalMode;
  var liveExecutions;
  var sourceTables;
  try {
    journalMode = source.prepare("PRAGMA journal_mode").get().journal_mode;
    liveExecutions = countExecutions(source);
    sourceTables = tableNames(source);
    // Single read transaction: the destination sees every committed WAL frame.
    source.exec("VACUUM INTO " + quoteLiteral(destPath));
  } finally {
    source.close();
  }

  var verified = openReadOnly(destPath);
  var snapshotExecutions;
  var snapshotTables;
  try {
    snapshotExecutions = countExecutions(verified);
    snapshotTables = tableNames(verified);
    var integrity = verified.prepare("PRAGMA integrity_check").get();
    var integrityResult = integrity[Object.keys(integrity)[0]];
    if (String(integrityResult) !== "ok") {
      throw new Error("Snapshot failed integrity_check: " + integrityResult);
    }
  } finally {
    verified.close();
  }

  if (snapshotTables.length !== sourceTables.length) {
    throw new Error("Snapshot table count " + snapshotTables.length +
      " does not match source " + sourceTables.length);
  }

  var walPath = sourcePath + "-wal";
  var walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

  return {
    sourcePath: sourcePath,
    destPath: destPath,
    journalMode: journalMode,
    walBytes: walBytes,
    tables: snapshotTables.length,
    liveExecutions: liveExecutions,
    snapshotExecutions: snapshotExecutions,
    mainFileOnly: readMainFileOnly(sourcePath),
    bytes: fs.statSync(destPath).size
  };
}

function quoteLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Reports every hand-made `.bak` beside the live store together with how far
// behind it actually is. Keeps the stale set discoverable without deleting or
// modifying files that belong to whoever made them.
function auditLegacyBackups(options) {
  assertAvailable();
  var opts = options || {};
  var sourcePath = opts.source || defaultSourcePath();
  var dir = path.dirname(sourcePath);
  var base = path.basename(sourcePath);

  var live = null;
  if (fs.existsSync(sourcePath)) {
    var db = openReadOnly(sourcePath);
    try {
      live = countExecutions(db);
    } finally {
      db.close();
    }
  }

  var entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  var results = [];
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i];
    if (name.indexOf(base + ".") !== 0) continue;
    if (!/\.bak$/.test(name)) continue;
    var full = path.join(dir, name);
    var probe = readMainFileOnly(full);
    results.push({
      name: name,
      executions: probe.ok ? probe.executions : null,
      error: probe.ok ? null : probe.error,
      behind: probe.ok && live != null ? live - probe.executions : null
    });
  }
  results.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  return { sourcePath: sourcePath, liveExecutions: live, backups: results };
}

function parseArgs(argv) {
  var opts = { audit: false };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === "--audit") opts.audit = true;
    else if (arg === "--label") opts.label = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--dir") opts.dir = argv[++i];
    else if (arg === "--source") opts.source = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error("Unknown argument: " + arg);
  }
  return opts;
}

function usage() {
  console.log([
    "Usage: node scripts/snapshot-control-store.js [options]",
    "",
    "  --label <name>   Label embedded in the snapshot filename (default: manual)",
    "  --dir <path>     Snapshot directory (default: <CLAY_HOME>/control-store-snapshots)",
    "  --out <file>     Exact snapshot path; overrides --dir/--label",
    "  --source <db>    Control store to snapshot (default: <CLAY_HOME>/lead/coop-control.sqlite)",
    "  --audit          Report staleness of the legacy hand-made .bak files and exit",
    "",
    "The source is opened read-only and is never modified."
  ].join("\n"));
}

function runAudit(opts) {
  var report = auditLegacyBackups(opts);
  console.log("[audit] store: " + report.sourcePath);
  console.log("[audit] live executions (WAL applied): " +
    (report.liveExecutions == null ? "unavailable" : report.liveExecutions));
  if (!report.backups.length) {
    console.log("[audit] no legacy .bak files found.");
    return 0;
  }
  console.log("[audit] " + report.backups.length + " legacy main-file-only .bak file(s):");
  for (var i = 0; i < report.backups.length; i++) {
    var row = report.backups[i];
    if (row.error) {
      console.log("  UNREADABLE  " + row.name + "  (" + row.error + ")");
    } else {
      var behind = row.behind == null ? "?" : row.behind;
      var flag = row.behind ? "UNSAFE" : "ok-ish";
      console.log("  " + flag + "  execs=" + row.executions + "  missing=" + behind + "  " + row.name);
    }
  }
  console.log("");
  console.log("[audit] These files copy only the main database file. The store is WAL-mode,");
  console.log("[audit] so any file listed UNSAFE is missing committed rows and must NOT be");
  console.log("[audit] used to restore. Take new snapshots with this script instead.");
  return 0;
}

function runSnapshot(opts) {
  var result = snapshotControlStore(opts);
  console.log("[snapshot] source       : " + result.sourcePath);
  console.log("[snapshot] journal_mode : " + result.journalMode);
  console.log("[snapshot] wal bytes    : " + result.walBytes);
  console.log("[snapshot] destination  : " + result.destPath);
  console.log("[snapshot] method       : VACUUM INTO (one consistent file, WAL frames included)");
  console.log("[snapshot] size bytes   : " + result.bytes);
  console.log("[snapshot] tables       : " + result.tables);
  console.log("[snapshot] executions   : " + result.snapshotExecutions +
    " (live at snapshot time: " + result.liveExecutions + ")");
  if (result.mainFileOnly.ok) {
    var lost = result.snapshotExecutions - result.mainFileOnly.executions;
    console.log("[snapshot] a main-file-only .bak would have captured " +
      result.mainFileOnly.executions + " executions" +
      (lost > 0 ? "  <-- " + lost + " row(s) would have been lost" : ""));
  } else {
    console.log("[snapshot] a main-file-only .bak would be unreadable: " + result.mainFileOnly.error);
  }
  console.log("[snapshot] integrity_check ok");
  return 0;
}

function main(argv) {
  var opts;
  try {
    opts = parseArgs(argv);
  } catch (parseError) {
    console.error(parseError.message);
    usage();
    return 2;
  }
  if (opts.help) {
    usage();
    return 0;
  }
  try {
    return opts.audit ? runAudit(opts) : runSnapshot(opts);
  } catch (runError) {
    console.error("[snapshot] failed: " + runError.message);
    return 1;
  }
}

module.exports = {
  snapshotControlStore: snapshotControlStore,
  auditLegacyBackups: auditLegacyBackups,
  defaultSourcePath: defaultSourcePath,
  defaultSnapshotDir: defaultSnapshotDir
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
