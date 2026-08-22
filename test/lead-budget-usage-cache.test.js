// Tests for the incremental session-log cache behind the Lead/Coop foreground
// turn. The cache exists to stop every tick re-reading ~722MB of
// ~/.clay/sessions/**/*.jsonl, so what has to be proven is EQUIVALENCE: the
// budget built from the cache must match the budget built from a full read,
// including across an append and across midnight.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var cache = require("../lib/lead-budget-usage-cache");
var budget = require("../lib/lead-budget");

var DAY = budget.DAY_MS;
var START = 1785800000000;

function tempRoot(name) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-usage-cache-" + name + "-"));
  return dir;
}

function metaLine(vendor, createdAt) {
  return JSON.stringify({ type: "meta", vendor: vendor, createdAt: createdAt });
}

function resultLine(at, cost, input, output) {
  return JSON.stringify({
    type: "result",
    _ts: at,
    cost: cost,
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

function noiseLine(at) {
  // The overwhelming majority of real session lines look like this: not meta,
  // not result, and irrelevant to the budget.
  return JSON.stringify({ type: "assistant", _ts: at, message: { content: "filler ".repeat(20) } });
}

// Full read of every line, i.e. exactly what the tick did before the cache.
function fullReadSessions(root) {
  var files = cache.listSessionFiles(root);
  return files.map(function (file) {
    var meta = null;
    var history = [];
    fs.readFileSync(file, "utf8").split("\n").forEach(function (line) {
      if (!line) return;
      var parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        return;
      }
      if (!parsed) return;
      if (parsed.type === "meta" && !meta) meta = parsed;
      else history.push(parsed);
    });
    return { vendor: meta && meta.vendor, createdAt: meta && meta.createdAt, history: history };
  });
}

function dailyFrom(sessions) {
  return budget.buildDailyBudget(sessions, {
    dayStartAt: START,
    vendorCostRank: { codex: 1, claude: 2 },
  });
}

function writeSession(root, name, lines) {
  var file = path.join(root, name);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("cached budget equals full-read budget on a populated tree", function () {
  var root = tempRoot("equiv");
  var cacheFile = path.join(root, "cache.json");
  writeSession(root, "a.jsonl", [
    metaLine("claude", START + 10),
    noiseLine(START + 20),
    resultLine(START + 100, 1.5, 1000, 200),
    noiseLine(START + 150),
    resultLine(START + 200, 4.5, 2000, 400),
  ]);
  writeSession(root, "b.jsonl", [
    metaLine("codex", START + 30),
    resultLine(START + 300, 2, 500, 50),
  ]);

  var refreshed = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  var cached = dailyFrom(refreshed.sessions);
  var full = dailyFrom(fullReadSessions(root));

  assert.deepStrictEqual(cached, full);
  assert.ok(cached.dataAvailable, "expected recorded usage for the day");
  assert.strictEqual(refreshed.stats.full, 2);
  assert.strictEqual(refreshed.stats.reused, 0);
});

test("second refresh reuses unchanged files and reads zero bytes", function () {
  var root = tempRoot("reuse");
  var cacheFile = path.join(root, "cache.json");
  writeSession(root, "a.jsonl", [
    metaLine("claude", START + 10),
    resultLine(START + 100, 1.5, 1000, 200),
  ]);

  var first = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  var second = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });

  assert.strictEqual(second.stats.reused, 1);
  assert.strictEqual(second.stats.full, 0);
  assert.strictEqual(second.stats.bytesRead, 0, "an unchanged file must not be re-read");
  assert.deepStrictEqual(dailyFrom(second.sessions), dailyFrom(first.sessions));
});

test("appended results are picked up by a delta read and match a full read", function () {
  var root = tempRoot("append");
  var cacheFile = path.join(root, "cache.json");
  var file = writeSession(root, "a.jsonl", [
    metaLine("claude", START + 10),
    resultLine(START + 100, 1.5, 1000, 200),
  ]);
  cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });

  fs.appendFileSync(file, noiseLine(START + 250) + "\n" + resultLine(START + 300, 7.5, 3000, 600) + "\n");
  var after = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });

  assert.strictEqual(after.stats.delta, 1, "a grown file must take the delta path");
  assert.ok(after.stats.bytesRead > 0 && after.stats.bytesRead < fs.statSync(file).size,
    "a delta read must read less than the whole file");
  assert.deepStrictEqual(dailyFrom(after.sessions), dailyFrom(fullReadSessions(root)));
});

// The regression this cache could most plausibly introduce. `aggregateSession`
// walks the FULL result list to carry `previousCost` forward and only gates the
// ADD step on the window, so a cache that kept "today only" would treat the
// first in-window cumulative cost as an absolute and overstate the day's spend.
test("pre-window results are retained so cross-midnight cost deltas stay correct", function () {
  var root = tempRoot("midnight");
  var cacheFile = path.join(root, "cache.json");
  writeSession(root, "a.jsonl", [
    metaLine("claude", START - DAY),
    // Yesterday: cumulative cost climbs to 10.
    resultLine(START - DAY + 10, 4, 100, 10),
    resultLine(START - DAY + 20, 10, 100, 10),
    // Today: cumulative cost 12, so today's true spend is the 2 delta.
    resultLine(START + 50, 12, 100, 10),
  ]);

  var refreshed = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  var cached = dailyFrom(refreshed.sessions);
  var full = dailyFrom(fullReadSessions(root));

  assert.deepStrictEqual(cached, full);
  // The delta, not the cumulative 12: proves the pre-midnight baseline survived.
  assert.strictEqual(cached.byVendor.claude.spendUsd, 2);
});

test("truncation or rotation forces a full re-read instead of trusting the offset", function () {
  var root = tempRoot("truncate");
  var cacheFile = path.join(root, "cache.json");
  var file = writeSession(root, "a.jsonl", [
    metaLine("claude", START + 10),
    resultLine(START + 100, 1.5, 1000, 200),
    resultLine(START + 200, 3, 1000, 200),
  ]);
  cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });

  // Rotated: same path, shorter content, different history.
  fs.writeFileSync(file, [metaLine("claude", START + 10), resultLine(START + 400, 9, 10, 1)].join("\n") + "\n");
  var after = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });

  assert.strictEqual(after.stats.full, 1, "a shrunken file must not take the delta path");
  assert.deepStrictEqual(dailyFrom(after.sessions), dailyFrom(fullReadSessions(root)));
});

test("a partial trailing line is not consumed until it is complete", function () {
  var root = tempRoot("partial");
  var cacheFile = path.join(root, "cache.json");
  var file = path.join(root, "a.jsonl");
  var complete = metaLine("claude", START + 10) + "\n" + resultLine(START + 100, 1.5, 1000, 200) + "\n";
  var partial = resultLine(START + 200, 5, 1000, 200);
  // Writer is mid-append: the last line has no newline yet.
  fs.writeFileSync(file, complete + partial.slice(0, 30));

  var first = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(first.sessions[0].history.length, 1, "half a line must not be parsed as an event");

  // Writer finishes the line.
  fs.writeFileSync(file, complete + partial + "\n");
  var second = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(second.sessions[0].history.length, 2);
  assert.deepStrictEqual(dailyFrom(second.sessions), dailyFrom(fullReadSessions(root)));
});

// Regression: `consumed` used to be a string index added to a byte offset, so
// any non-ASCII line drifted the resume point backwards and the next delta read
// re-counted result events it had already stored. 50 emoji lines drifted 4000
// bytes and turned 2 turns into 3.
test("non-ASCII content keeps the resume offset in bytes and never double-counts", function () {
  var root = tempRoot("utf8");
  var cacheFile = path.join(root, "cache.json");
  var lines = [metaLine("claude", START + 1)];
  for (var i = 0; i < 50; i++) {
    lines.push(JSON.stringify({ type: "assistant", _ts: START + i, message: "日本語🚀".repeat(40) }));
  }
  lines.push(resultLine(START + 100, 5, 1000, 200));
  var file = writeSession(root, "a.jsonl", lines);

  var first = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(
    first.cache.files[file].offset,
    fs.statSync(file).size,
    "a fully consumed file must leave the offset at its byte size"
  );

  fs.appendFileSync(file, resultLine(START + 200, 9, 10, 1) + "\n");
  var second = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });

  assert.strictEqual(second.sessions[0].history.length, 2, "no result event may be counted twice");
  var daily = dailyFrom(second.sessions);
  assert.strictEqual(daily.byVendor.claude.turns, 2);
  assert.deepStrictEqual(daily, dailyFrom(fullReadSessions(root)));
});

// Found independently by two reviewers, and it is not theoretical: session
// transcripts are rewritten wholesale via temp-file + rename
// (sessions-persistence.js:344,350). Such a rewrite normally GROWS the file
// while changing the prefix -- the meta line is mutable and delta coalescing
// shortens earlier runs -- so a shrink-only guard takes the delta path, resumes
// mid-line, and mixes stale events into the budget.
test("a rewrite that grows the file is not mistaken for an append", function () {
  var root = tempRoot("rewrite-grow");
  var cacheFile = path.join(root, "cache.json");
  var file = writeSession(root, "a.jsonl", [
    metaLine("claude", START + 1),
    resultLine(START + 100, 4, 100, 10),
  ]);
  var first = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(first.sessions[0].history.length, 1);

  // Atomic rewrite, exactly as writeSessionFileNow does: longer meta line, a
  // different event set, and a LARGER total size than before.
  var replacement = [
    JSON.stringify({ type: "meta", vendor: "claude", createdAt: START + 1, padding: "x".repeat(400) }),
    resultLine(START + 500, 11, 100, 10),
  ].join("\n") + "\n";
  fs.writeFileSync(file + ".tmp", replacement);
  fs.renameSync(file + ".tmp", file);
  assert.ok(fs.statSync(file).size > first.cache.files[file].size, "the rewrite must grow the file");

  var after = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(after.stats.full, 1, "a rewritten file must take the full path, not delta");
  assert.strictEqual(after.sessions[0].history.length, 1, "the superseded event must be gone");
  assert.strictEqual(after.sessions[0].history[0].cost, 11);
  assert.deepStrictEqual(dailyFrom(after.sessions), dailyFrom(fullReadSessions(root)));
});

// The previous rewrite test did not isolate the inode guard: the stale offset
// happened to land mid-line, so the newline probe forced the full read on its
// own. This one lands the old offset exactly on a newline in the replacement, so
// ONLY the inode comparison can reject it.
test("the inode guard alone rejects a rewrite whose old offset still lands on a newline", function () {
  var root = tempRoot("ino-isolate");
  var cacheFile = path.join(root, "cache.json");
  var head = metaLine("claude", START + 1) + "\n" + resultLine(START + 100, 4, 100, 10) + "\n";
  var file = path.join(root, "a.jsonl");
  fs.writeFileSync(file, head);

  var first = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  var oldOffset = first.cache.files[file].offset;
  assert.strictEqual(oldOffset, head.length);

  // Replacement keeps the identical prefix, so byte oldOffset-1 is still "\n"
  // and the newline probe cannot tell the difference. Only the inode can.
  fs.writeFileSync(file + ".tmp", head + resultLine(START + 400, 9, 10, 1) + "\n");
  fs.renameSync(file + ".tmp", file);
  var boundary = Buffer.alloc(1);
  var fd = fs.openSync(file, "r");
  fs.readSync(fd, boundary, 0, 1, oldOffset - 1);
  fs.closeSync(fd);
  assert.strictEqual(boundary[0], 0x0a, "the newline probe must be unable to reject this");

  var after = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(after.stats.full, 1, "the inode change alone must force a full read");
  assert.deepStrictEqual(dailyFrom(after.sessions), dailyFrom(fullReadSessions(root)));
});

test("a v1 cache is rejected rather than trusted", function () {
  var root = tempRoot("v1");
  var cacheFile = path.join(root, "cache.json");
  var file = writeSession(root, "a.jsonl", [
    metaLine("claude", START + 1),
    resultLine(START + 100, 4, 100, 10),
  ]);
  var stat = fs.statSync(file);
  // A v1 entry claims the file is fully consumed but carries no inode, so its
  // offset was never prefix-checked.
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1,
    files: (function () {
      var files = {};
      files[file] = { size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, meta: null, results: [] };
      return files;
    })(),
  }));

  var refreshed = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(refreshed.stats.reused, 0, "a v1 entry must not be reused");
  assert.strictEqual(refreshed.stats.full, 1);
  assert.deepStrictEqual(dailyFrom(refreshed.sessions), dailyFrom(fullReadSessions(root)));
});

// A short readSync used to be cached as a whole file: size from stat, offset
// from the truncated scan. Because reuse only compares size/mtime/ino, that bad
// entry was then reused forever and under-reported the day's turns.
//
// Two redundant guards now cover this -- the read loop in readRange and the
// `bytesRead !== stat.size - from` completeness check -- so this test only fails
// when BOTH are removed. Removing either alone is masked by the other. That is
// deliberate defence in depth, but it means this test does not isolate either
// guard on its own; do not read a pass here as proof that both are present.
test("a short read is not cached as a fully consumed file", function () {
  var root = tempRoot("short");
  var cacheFile = path.join(root, "cache.json");
  writeSession(root, "a.jsonl", [
    metaLine("claude", START + 1),
    resultLine(START + 100, 4, 100, 10),
  ]);
  var real = fs.readSync;
  var calls = 0;
  // Truncate only the first bulk read, exactly as a short read would.
  fs.readSync = function (fd, buffer, offset, length, position) {
    calls++;
    if (calls === 1 && length > 40) return real(fd, buffer, offset, 40, position);
    return real(fd, buffer, offset, length, position);
  };
  var refreshed;
  try {
    refreshed = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  } finally {
    fs.readSync = real;
  }

  assert.deepStrictEqual(
    dailyFrom(refreshed.sessions),
    dailyFrom(fullReadSessions(root)),
    "a short read must not lose the result event"
  );
  var second = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.deepStrictEqual(dailyFrom(second.sessions), dailyFrom(fullReadSessions(root)));
});

test("a corrupt cache file degrades to a cold rebuild rather than throwing", function () {
  var root = tempRoot("corrupt");
  var cacheFile = path.join(root, "cache.json");
  writeSession(root, "a.jsonl", [
    metaLine("claude", START + 10),
    resultLine(START + 100, 1.5, 1000, 200),
  ]);
  fs.writeFileSync(cacheFile, "{not json");

  var refreshed = cache.refresh({ sessionsRoot: root, cacheFile: cacheFile });
  assert.strictEqual(refreshed.stats.full, 1);
  assert.deepStrictEqual(dailyFrom(refreshed.sessions), dailyFrom(fullReadSessions(root)));
});
