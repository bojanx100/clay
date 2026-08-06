var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var TMP = path.join(os.tmpdir(), "clay-probe-test-" + process.pid);
process.env.CLAY_MODEL_PROBE_PATH = path.join(TMP, "probe.json");
var probe = require("../lib/claude-model-probe");

function reset() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }

// A fake SDK query() returning an async-iterable of the given messages.
function fakeRunner(messages) {
  return function () {
    return (async function* () { for (var m of messages) yield m; })();
  };
}

test("classifyError: model rejections are definitive, transient errors are not", function () {
  assert.deepStrictEqual(probe.classifyError("model claude-opus-5 does not exist"), { available: false, definitive: true });
  assert.deepStrictEqual(probe.classifyError("no access to this model"), { available: false, definitive: true });
  assert.deepStrictEqual(probe.classifyError("rate limit exceeded"), { available: false, definitive: false });
  assert.deepStrictEqual(probe.classifyError("stream disconnected"), { available: false, definitive: false });
});

test("probeModel maps a success result to available+definitive", async function () {
  reset();
  var v = await probe.probeModel("claude-opus-5", {
    binaryPath: "/bin/true",
    queryRunner: fakeRunner([{ type: "system", subtype: "init", model: "claude-opus-5" }, { type: "result", subtype: "success" }]),
  });
  assert.deepStrictEqual(v, { available: true, definitive: true });
  reset();
});

test("probeModel maps a model-rejection result to unavailable+definitive", async function () {
  reset();
  var v = await probe.probeModel("claude-opus-5", {
    binaryPath: "/bin/true",
    queryRunner: fakeRunner([{ type: "result", subtype: "error_during_execution", result: "invalid model: claude-opus-5" }]),
  });
  assert.deepStrictEqual(v, { available: false, definitive: true });
  reset();
});

test("cache verdict round-trip + asymmetric TTL freshness", function () {
  reset();
  probe.recordVerdict("claude-opus-5", { available: true, definitive: true });
  var c = probe.cachedEntry("claude-opus-5");
  assert.strictEqual(c.available, true);
  assert.strictEqual(c.fresh, true); // just written -> fresh
  assert.strictEqual(probe.cachedEntry("nonexistent-model"), null);
  reset();
});

test("extraClaudeModels: shows a cached-available candidate, hides unavailable, skips already-advertised", async function () {
  reset();
  // unknown -> not shown yet, but a background probe is triggered
  var out0 = probe.extraClaudeModels(["opus", "sonnet"], {
    binaryPath: "/bin/true",
    queryRunner: fakeRunner([{ type: "result", subtype: "success" }]),
  });
  assert.strictEqual(out0.length, 0, "unknown candidate is not offered on first sight");
  // let the background probe write its verdict
  await new Promise(function (r) { setTimeout(r, 30); });

  var out1 = probe.extraClaudeModels(["opus", "sonnet"]);
  assert.strictEqual(out1.length, 1, "candidate now offered after successful probe");
  assert.strictEqual(out1[0].value, "claude-opus-5");
  assert.strictEqual(out1[0].displayName, "Opus 5");

  // already advertised by the authoritative list -> never added
  var out2 = probe.extraClaudeModels(["opus", "claude-opus-5"]);
  assert.strictEqual(out2.length, 0, "already-advertised candidate is not duplicated");

  // unavailable verdict -> hidden
  probe.recordVerdict("claude-opus-5", { available: false, definitive: true });
  var out3 = probe.extraClaudeModels(["opus"]);
  assert.strictEqual(out3.length, 0, "unavailable candidate is hidden");
  reset();
});
