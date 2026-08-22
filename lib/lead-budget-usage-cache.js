"use strict";

// Incremental cache of the ONLY session-log lines the daily budget consumes:
// `result` events (1.04% of ~722MB of ~/.clay/sessions/**/*.jsonl as measured
// 2026-08-22). Before this cache every Lead/Coop tick read every byte of every
// session file to let `lead-budget.aggregateDailyUsage` throw away ~99% of it.
//
// Two correctness rules constrain the design and must not be "optimized" away:
//
//  1. NEVER drop pre-window result events. `lead-budget.aggregateSession`
//     iterates the FULL result-event list to carry the `previousCost` baseline
//     forward (lib/lead-budget.js:120-131); only the ADD step is window-gated.
//     Filtering the cache to "today" would silently turn cumulative costs into
//     first-seen absolutes and report a wrong burn rate. So this cache retains
//     every result event per session, forever, and the window stays the
//     library's job.
//  2. This module extracts lines; it computes NO budget. The reconstructed
//     sessions go to the real `buildDailyBudget`, so budget semantics cannot
//     drift from the cache.
//
// Invalidation is explicit and stat-based, never time-based: a file is reused
// only when size AND mtimeMs both match the cached entry. Growth reads just the
// appended byte range; truncation or rotation forces a full re-read.

var fs = require("fs");
var path = require("path");
var os = require("os");

// v2 added `ino` to each entry. Bumping the version discards v1 entries rather
// than trusting an offset whose prefix was never inode-checked; the cost is one
// cold rebuild.
var CACHE_VERSION = 2;
var READ_CONCURRENCY = 32;

function defaultSessionsRoot() {
  return path.join(os.homedir(), ".clay", "sessions");
}

function defaultCacheFile() {
  return path.join(os.homedir(), ".clay", "lead", "budget-usage-cache.json");
}

var writeSequence = 0;

function threadTag() {
  try {
    return String(require("worker_threads").threadId);
  } catch (err) {
    return "0";
  }
}

function emptyCache() {
  return { version: CACHE_VERSION, files: {} };
}

function loadCache(file, fsImpl) {
  var impl = fsImpl || fs;
  var raw;
  try {
    raw = impl.readFileSync(file, "utf8");
  } catch (err) {
    return emptyCache();
  }
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A corrupt cache is never fatal: it only costs one cold rebuild.
    return emptyCache();
  }
  if (!parsed || parsed.version !== CACHE_VERSION || !parsed.files) return emptyCache();
  return parsed;
}

function saveCache(file, state, fsImpl) {
  var impl = fsImpl || fs;
  try {
    impl.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    // Directory may already exist; a real failure surfaces on write below.
  }
  // pid alone collides between worker threads, which share it: two same-process
  // writers raced on one temp name and lost 77 of 200 saves plus produced a
  // malformed read. The counter disambiguates within a process; the thread id is
  // included where the runtime exposes one.
  writeSequence++;
  var temp = file + ".tmp-" + process.pid + "-" + threadTag() + "-" + writeSequence;
  try {
    impl.writeFileSync(temp, JSON.stringify(state));
    impl.renameSync(temp, file);
    return true;
  } catch (err) {
    try {
      impl.unlinkSync(temp);
    } catch (cleanupErr) {
      // Nothing further to do; the cache is advisory.
    }
    return false;
  }
}

function listSessionFiles(root, fsImpl) {
  var impl = fsImpl || fs;
  var out = [];
  function walk(dir) {
    var entries;
    try {
      entries = impl.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.slice(-6) === ".jsonl") out.push(full);
    }
  }
  walk(root);
  out.sort();
  return out;
}

// Parses complete lines only and reports how many BYTES were consumed, so the
// caller can resume mid-file without ever splitting a JSON object.
//
// This scans a Buffer rather than a string on purpose. `consumed` is added to a
// byte offset, and a string index is NOT a byte offset: one line of CJK or
// emoji makes `String.prototype.indexOf` drift below the true byte position,
// the next delta read starts too early, and already-counted `result` events get
// re-appended. Measured before the fix: 50 emoji-bearing lines drifted the
// offset by 4000 bytes and double-counted a result event, reporting 3 turns for
// 2. Decoding each line separately also means a multi-byte character can never
// straddle a read boundary.
function scanLines(buffer) {
  var buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), "utf8");
  var results = [];
  var meta = null;
  var consumed = 0;
  var start = 0;
  while (true) {
    var nl = buf.indexOf(0x0a, start);
    if (nl === -1) break;
    var line = buf.toString("utf8", start, nl);
    start = nl + 1;
    consumed = start;
    if (!line) continue;
    // Cheap prefilter before the expensive parse: the vast majority of lines
    // are neither meta nor result.
    var maybeResult = line.indexOf("\"result\"") !== -1;
    var maybeMeta = !meta && line.indexOf("\"meta\"") !== -1;
    if (!maybeResult && !maybeMeta) continue;
    var parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      continue;
    }
    if (!parsed) continue;
    if (parsed.type === "result") results.push(parsed);
    else if (!meta && parsed.type === "meta") meta = parsed;
  }
  return { results: results, meta: meta, consumed: consumed };
}

// Returns a Buffer, not a string: the caller needs byte positions to resume a
// delta read, and decoding here would lose them.
//
// readSync is not guaranteed to return the full requested length in one call.
// A single short read used to be cached as if the file had been consumed whole
// (size from stat, offset from the truncated scan), and because the reuse check
// only compares size/mtime/ino that bad entry was then reused forever -- a
// 152-byte file read 60 bytes short reported zero turns instead of one. So loop
// until the range is exhausted or the file stops yielding.
function readRange(file, from, to, fsImpl) {
  var impl = fsImpl || fs;
  var length = to - from;
  if (length <= 0) return Buffer.alloc(0);
  var fd = impl.openSync(file, "r");
  try {
    var buffer = Buffer.allocUnsafe(length);
    var filled = 0;
    while (filled < length) {
      var read = impl.readSync(fd, buffer, filled, length - filled, from + filled);
      if (!read) break;
      filled += read;
    }
    return buffer.subarray(0, filled);
  } finally {
    impl.closeSync(fd);
  }
}

function statOrNull(file, fsImpl) {
  var impl = fsImpl || fs;
  try {
    return impl.statSync(file);
  } catch (err) {
    return null;
  }
}

// A resume offset is only meaningful if the bytes BEFORE it are still the same
// bytes. Size alone does not establish that: session transcripts are rewritten
// wholesale via temp-file + rename (sessions-persistence.js:344,350), and such a
// rewrite usually GROWS the file while changing the prefix -- the meta line is
// mutable (302KB on the canonical Coop session) and delta coalescing shortens
// earlier runs. A shrink-only guard misses that case entirely, takes the delta
// path, resumes mid-line, and mixes stale events into the budget.
//
// The rewrite is an atomic rename, so it always lands a NEW inode while an
// in-place append keeps the old one. Inode is therefore the exact discriminator
// and costs nothing extra -- it is already in the stat we take. The newline
// probe is a second, cheap line of defence for an in-place rewrite that somehow
// keeps the inode: if the prefix length changed, offset-1 is almost never a
// newline any more.
//
// Known accepted limit: an in-place rewrite that preserves inode, size AND
// mtimeMs is indistinguishable by stat. That does not occur for append-only
// logs, and the cache is advisory -- worst case is one stale tick.
function prefixIntact(file, cached, stat, fsImpl) {
  if (typeof cached.ino === "number" && cached.ino !== stat.ino) return false;
  if (!cached.offset) return false;
  var boundary = readRange(file, cached.offset - 1, cached.offset, fsImpl);
  return boundary.length === 1 && boundary[0] === 0x0a;
}

function entryForFile(file, cached, stat, fsImpl) {
  // Fully unchanged: reuse without touching the file body at all.
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs &&
      (typeof cached.ino !== "number" || cached.ino === stat.ino)) {
    return { entry: cached, mode: "reused", bytesRead: 0 };
  }
  var from = 0;
  var base = { results: [], meta: null };
  var mode = "full";
  // Append-only growth is the common case; anything else re-reads from zero so
  // rotation or rewrite cannot leave stale events behind.
  if (cached && typeof cached.offset === "number" && stat.size >= cached.offset &&
      cached.offset > 0 && prefixIntact(file, cached, stat, fsImpl)) {
    from = cached.offset;
    base = { results: cached.results || [], meta: cached.meta || null };
    mode = "delta";
  }
  var chunk = readRange(file, from, stat.size, fsImpl);
  var bytesRead = chunk.length;

  // The stat that sized this read happened BEFORE it, so an atomic replacement
  // in between left the parsed bytes belonging to a different file generation
  // than the identity about to be cached -- which mixed old and new events into
  // one budget. A short readSync is the same hazard from the other direction:
  // fewer bytes than the range, cached as if whole.
  //
  // Both are rare, so pay for correctness immediately rather than caching a lie
  // and healing next tick: re-stat, and if the file moved or the range was not
  // fully consumed, discard the delta base and re-read the whole file once
  // against the fresh stat.
  var after = statOrNull(file, fsImpl);
  var stable = !!after && after.size === stat.size && after.mtimeMs === stat.mtimeMs &&
    (typeof after.ino !== "number" || typeof stat.ino !== "number" || after.ino === stat.ino);
  if (!stable || bytesRead !== stat.size - from) {
    var fresh = after || stat;
    from = 0;
    base = { results: [], meta: null };
    mode = "full";
    chunk = readRange(file, 0, fresh.size, fsImpl);
    bytesRead += chunk.length;
    stat = fresh;
  }

  var scanned = scanLines(chunk);
  var entry = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: typeof stat.ino === "number" ? stat.ino : null,
    offset: from + scanned.consumed,
    meta: base.meta || scanned.meta || null,
    results: base.results.concat(scanned.results),
  };
  return { entry: entry, mode: mode, bytesRead: bytesRead };
}

function sessionFromEntry(entry) {
  var meta = entry.meta || {};
  return {
    vendor: meta.vendor || null,
    createdAt: typeof meta.createdAt === "number" ? meta.createdAt : null,
    history: entry.results || [],
  };
}

// Refreshes the cache against the current session tree and returns the session
// list shaped exactly as `lead-budget.buildDailyBudget` expects.
function refresh(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var root = opts.sessionsRoot || defaultSessionsRoot();
  var cacheFile = opts.cacheFile || defaultCacheFile();
  var cache = opts.cache || loadCache(cacheFile, fsImpl);
  var files = listSessionFiles(root, fsImpl);
  var next = { version: CACHE_VERSION, files: {} };
  var sessions = [];
  var stats = { files: files.length, reused: 0, delta: 0, full: 0, bytesRead: 0, missing: 0 };

  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var stat = statOrNull(file, fsImpl);
    if (!stat || !stat.isFile()) {
      stats.missing++;
      continue;
    }
    var computed;
    try {
      computed = entryForFile(file, cache.files[file], stat, fsImpl);
    } catch (err) {
      stats.missing++;
      continue;
    }
    next.files[file] = computed.entry;
    stats[computed.mode]++;
    stats.bytesRead += computed.bytesRead;
    sessions.push(sessionFromEntry(computed.entry));
  }

  var saved = opts.save === false ? false : saveCache(cacheFile, next, fsImpl);
  return { sessions: sessions, cache: next, stats: stats, cacheFile: cacheFile, saved: saved };
}

module.exports = {
  CACHE_VERSION: CACHE_VERSION,
  READ_CONCURRENCY: READ_CONCURRENCY,
  defaultCacheFile: defaultCacheFile,
  defaultSessionsRoot: defaultSessionsRoot,
  emptyCache: emptyCache,
  listSessionFiles: listSessionFiles,
  loadCache: loadCache,
  refresh: refresh,
  saveCache: saveCache,
  scanLines: scanLines,
  sessionFromEntry: sessionFromEntry,
};
