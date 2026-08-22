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
