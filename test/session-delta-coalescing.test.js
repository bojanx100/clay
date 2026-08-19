"use strict";

// Streaming records one delta per chunk, so a long turn lands hundreds of
// ~50-byte lines whose JSON framing costs more than their payload. The Coop
// transcript reached 218k items / 42MB that way and is parsed into the heap on
// every startup. Runs of deltas are now joined on the way to disk.
//
// The property that matters is losslessness: every reader concatenates delta
// text, so the joined text must be byte-identical to what those readers would
// have produced before.

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var persistence = require("../lib/sessions-persistence");

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clay-coalesce-")), name);
}

function writeAndRead(history) {
  var file = tmpFile("session.jsonl");
  persistence.writeSessionJsonlSync(file, JSON.stringify({ type: "meta" }), history);
  var lines = fs.readFileSync(file, "utf8").split("\n").filter(function (l) { return l !== ""; });
  return lines.map(function (l) { return JSON.parse(l); });
}

function joinedDeltaText(entries) {
  var text = "";
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].type === "delta" && entries[i].text) text += entries[i].text;
  }
  return text;
}

test("a run of streaming deltas is written as one delta", function () {
  var history = [];
  for (var i = 0; i < 500; i++) history.push({ type: "delta", text: "chunk" + i, _ts: 1000 + i });

  var written = writeAndRead(history);
  var deltas = written.filter(function (e) { return e.type === "delta"; });

  assert.equal(deltas.length, 1, "500 streaming deltas must collapse to one line");
  assert.equal(deltas[0].text, joinedDeltaText(history), "joined text must be identical");
  assert.equal(deltas[0]._ts, 1000, "the run keeps the timestamp it started at");
});

test("coalescing never changes what a reader concatenates", function () {
  var history = [
    { type: "user_message", text: "go" },
    { type: "delta", text: "Hel", _ts: 1 },
    { type: "delta", text: "lo ", _ts: 2 },
    { type: "delta", text: "world", _ts: 3 },
    { type: "tool_start", id: "a" },
    { type: "delta", text: "after", _ts: 4 },
    { type: "done", code: 0 },
  ];

  var written = writeAndRead(history);
  assert.equal(joinedDeltaText(written), joinedDeltaText(history));
});

test("deltas are not merged across an intervening entry", function () {
  var history = [
    { type: "delta", text: "before", _ts: 1 },
    { type: "tool_result", id: "a", content: "x" },
    { type: "delta", text: "after", _ts: 2 },
  ];

  var written = writeAndRead(history).filter(function (e) { return e.type !== "meta"; });
  var types = written.map(function (e) { return e.type; });

  assert.deepEqual(types, ["delta", "tool_result", "delta"],
    "a run must stop at any non-delta entry");
  assert.equal(written[0].text, "before");
  assert.equal(written[2].text, "after");
});

test("every non-delta entry is preserved exactly", function () {
  var history = [
    { type: "user_message", text: "go", _ts: 1 },
    { type: "delta", text: "a", _ts: 2 },
    { type: "delta", text: "b", _ts: 3 },
    { type: "tool_result", id: "x", content: "out", is_error: false, _ts: 4 },
    { type: "result", cost: 0.5, _ts: 5 },
  ];

  var written = writeAndRead(history);
  var nonDelta = written.filter(function (e) {
    return e.type !== "delta" && e.type !== "meta";
  });

  assert.deepEqual(nonDelta, [
    { type: "user_message", text: "go", _ts: 1 },
    { type: "tool_result", id: "x", content: "out", is_error: false, _ts: 4 },
    { type: "result", cost: 0.5, _ts: 5 },
  ]);
});

test("a delta carrying any extra field is written through untouched", function () {
  var history = [
    { type: "delta", text: "a", _ts: 1 },
    { type: "delta", text: "b", _ts: 2, channel: "thinking" },
    { type: "delta", text: "c", _ts: 3 },
  ];

  var written = writeAndRead(history);
  var deltas = written.filter(function (e) { return e.type !== "meta"; });

  // The tagged delta must survive with its field intact rather than being
  // absorbed into a neighbouring run and silently losing it.
  var tagged = deltas.filter(function (e) { return e.channel === "thinking"; });
  assert.equal(tagged.length, 1, "the tagged delta must survive");
  assert.equal(tagged[0].text, "b");
  assert.equal(joinedDeltaText(written), "abc", "no text may be lost");
});

test("a non-string delta text is not merged", function () {
  var history = [
    { type: "delta", text: "a", _ts: 1 },
    { type: "delta", text: null, _ts: 2 },
  ];

  var written = writeAndRead(history);
  var deltas = written.filter(function (e) { return e.type === "delta"; });
  assert.equal(deltas.length, 2);
  assert.equal(deltas[1].text, null);
});

test("a transcript of only deltas still round-trips", function () {
  var history = [
    { type: "delta", text: "one", _ts: 1 },
    { type: "delta", text: "two", _ts: 2 },
  ];

  var written = writeAndRead(history);
  assert.equal(written.length, 2, "meta plus a single coalesced delta");
  assert.equal(written[1].text, "onetwo");
});

test("an empty history writes only its meta line", function () {
  var written = writeAndRead([]);
  assert.equal(written.length, 1);
  assert.equal(written[0].type, "meta");
});
