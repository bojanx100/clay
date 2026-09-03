var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
require("./helpers/isolated-clay-home");

var TMP = path.join(os.tmpdir(), "clay-probe-test-" + process.pid);
process.env.CLAY_MODEL_CATALOG_PATH = path.join(TMP, "catalog.json");
var probe = require("../lib/claude-model-probe");
var providerHealth = require("../lib/provider-health");

function reset() {
  probe.resetInFlight();
  providerHealth._reset();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

function probeDeps(overrides) {
  return Object.assign({
    accountKey: "account-a",
    routeId: "claude-anthropic",
    sdkVersion: "0.3.223",
    backendVersion: "2.1.223",
    binaryPath: "/bin/true",
  }, overrides || {});
}

function successfulMessages(resolvedModel) {
  return [
    { type: "system", subtype: "init", model: resolvedModel },
    { type: "assistant", message: { content: [{ type: "text", text: "PONG" }] } },
    { type: "result", subtype: "success" },
  ];
}

function fakeRunner(messages, onCall) {
  return function () {
    if (onCall) onCall();
    return (async function* () {
      for (var i = 0; i < messages.length; i++) yield messages[i];
    })();
  };
}

test("classifyError separates access denial from transient route health", function () {
  assert.deepStrictEqual(probe.classifyError("model claude-opus-5 does not exist"),
    { available: false, definitive: true, reason: "access-denied" });
  assert.deepStrictEqual(probe.classifyError("403 no access to this model"),
    { available: false, definitive: true, reason: "access-denied" });
  assert.deepStrictEqual(probe.classifyError("rate limit exceeded"),
    { available: false, definitive: false, reason: "rate-or-quota" });
  assert.deepStrictEqual(probe.classifyError("stream disconnected"),
    { available: false, definitive: false, reason: "transport" });
});

test("probe succeeds only after exact resolution and a successful PONG reply", async function () {
  reset();
  var verdict = await probe.probeModel("claude-opus-5", probeDeps({
    queryRunner: fakeRunner(successfulMessages("claude-opus-5")),
  }));
  assert.deepStrictEqual(verdict, {
    available: true,
    definitive: true,
    reason: "exact-probe-success",
    resolvedModel: "claude-opus-5",
  });
  reset();
});

test("probe rejects a successful reply from the wrong resolved model", async function () {
  reset();
  var verdict = await probe.probeModel("claude-opus-5", probeDeps({
    queryRunner: fakeRunner(successfulMessages("claude-opus-4-8")),
  }));
  assert.deepStrictEqual(verdict, {
    available: false,
    definitive: true,
    reason: "wrong-resolved-model",
    resolvedModel: "claude-opus-4-8",
  });
  reset();
});

test("access denied is durable negative capability evidence", async function () {
  reset();
  var deps = probeDeps({
    queryRunner: fakeRunner([
      { type: "result", subtype: "error_during_execution", result: "403 no access to model claude-opus-5" },
    ]),
  });
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", deps), false);
  var cached = probe.cachedEntry("claude-opus-5", deps);
  assert.strictEqual(cached.available, false);
  assert.strictEqual(cached.definitive, true);
  assert.strictEqual(cached.reason, "access-denied");
  assert.strictEqual(providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-opus-5").state,
    "healthy", "account capability denial is not provider health");
  reset();
});

test("rate limit does not erase previously verified capability", async function () {
  reset();
  var deps = probeDeps();
  probe.recordVerdict("claude-opus-5", {
    available: true,
    definitive: true,
    reason: "exact-probe-success",
    resolvedModel: "claude-opus-5",
  }, deps);
  var result = await probe.ensureProbe("claude-opus-5", Object.assign({}, deps, {
    force: true,
    queryRunner: fakeRunner([
      { type: "result", subtype: "error_during_execution", result: "rate limit exceeded" },
    ]),
  }));
  assert.strictEqual(result, true);
  var cached = probe.cachedEntry("claude-opus-5", deps);
  assert.strictEqual(cached.available, true);
  assert.strictEqual(cached.definitive, true);
  assert.strictEqual(cached.lastAttempt.reason, "rate-or-quota");
  var health = providerHealth.getRouteHealth("claude", "claude-anthropic", "claude-opus-5");
  assert.strictEqual(health.targetState, "degraded");
  assert.strictEqual(health.vendorState, "healthy");
  reset();
});

test("cache is reused for the same account, route, SDK, backend, and model", async function () {
  reset();
  var calls = 0;
  var deps = probeDeps({
    queryRunner: fakeRunner(successfulMessages("claude-opus-5"), function () { calls++; }),
  });
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", deps), true);
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", deps), true);
  assert.strictEqual(calls, 1);
  reset();
});

test("account and route changes invalidate exact capability evidence", async function () {
  reset();
  var calls = 0;
  function dependencies(accountKey, routeId) {
    return probeDeps({
      accountKey: accountKey,
      routeId: routeId,
      queryRunner: fakeRunner(successfulMessages("claude-opus-5"), function () { calls++; }),
    });
  }
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", dependencies("account-a", "claude-anthropic")), true);
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", dependencies("account-b", "claude-anthropic")), true);
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", dependencies("account-b", "claude-other")), true);
  assert.strictEqual(calls, 3);
  reset();
});

test("SDK or backend version changes require a new probe", async function () {
  reset();
  var calls = 0;
  function dependencies(sdkVersion, backendVersion) {
    return probeDeps({
      sdkVersion: sdkVersion,
      backendVersion: backendVersion,
      queryRunner: fakeRunner(successfulMessages("claude-opus-5"), function () { calls++; }),
    });
  }
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", dependencies("sdk-a", "backend-a")), true);
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", dependencies("sdk-b", "backend-a")), true);
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", dependencies("sdk-b", "backend-b")), true);
  assert.strictEqual(calls, 3);
  reset();
});

test("positive evidence exposes Opus 5, then native advertisement supersedes the special case", async function () {
  reset();
  var calls = 0;
  var deps = probeDeps({
    queryRunner: fakeRunner(successfulMessages("claude-opus-5"), function () { calls++; }),
  });
  assert.deepStrictEqual(probe.extraClaudeModels(["opus", "sonnet"],
    Object.assign({}, deps, { background: false })), []);
  assert.strictEqual(await probe.ensureProbe("claude-opus-5", deps), true);
  var extras = probe.extraClaudeModels(["opus", "sonnet"], Object.assign({}, deps, { background: false }));
  assert.strictEqual(extras.length, 1);
  assert.strictEqual(extras[0].value, "claude-opus-5");
  assert.deepStrictEqual(probe.extraClaudeModels(["opus", "claude-opus-5"], deps), []);
  assert.strictEqual(calls, 1, "native advertisement must not run or duplicate the probe special case");
  reset();
});

test("mergeExtras inserts a verified Opus 5 route near the frontier models", function () {
  var base = [
    { value: "best" }, { value: "default" }, { value: "opus" },
    { value: "claude-fable-5" }, { value: "sonnet" }, { value: "haiku" },
  ];
  var out = probe.mergeExtras(base, [{ value: "claude-opus-5" }]);
  assert.deepStrictEqual(out.map(function (model) { return model.value; }),
    ["best", "default", "opus", "claude-fable-5", "claude-opus-5", "sonnet", "haiku"]);
});

// Regression: a definitive verdict was treated as fresh forever, with no age
// check at all. classifyError() marks "unauthorized"/"forbidden"/"no access" as
// definitive, so an outage that answers like an entitlement error records a
// permanent "unavailable". extraClaudeModels() only offers models whose cached
// entry is `available`, and only re-probes entries that are not fresh -- so the
// model stays silently missing from the picker forever, with nothing that can
// ever correct it (no caller anywhere passes force:true).
function writeCapability(model, deps, entry) {
  var key = require("../lib/model-catalog-cache").capabilityKey(probe.contextFor(model, deps));
  fs.mkdirSync(TMP, { recursive: true });
  var caps = {};
  caps[key] = entry;
  fs.writeFileSync(process.env.CLAY_MODEL_CATALOG_PATH,
    JSON.stringify({ version: 3, vendors: {}, capabilities: caps }));
}

var DAY_MS = 24 * 60 * 60 * 1000;

test("a stale definitive-unavailable verdict expires so the model can be re-probed", function () {
  reset();
  var deps = probeDeps();
  writeCapability("claude-opus-5", deps, {
    available: false,
    definitive: true,
    reason: "access-denied",
    attemptedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
  });
  var cached = probe.cachedEntry("claude-opus-5", deps);
  assert.strictEqual(cached.available, false);
  assert.strictEqual(cached.fresh, false,
    "an 8-day-old definitive negative must not be treated as fresh, or nothing ever re-probes it");
  reset();
});

test("a recent definitive-unavailable verdict stays fresh, so there is no probe storm", function () {
  reset();
  var deps = probeDeps();
  writeCapability("claude-opus-5", deps, {
    available: false,
    definitive: true,
    reason: "access-denied",
    attemptedAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  assert.strictEqual(probe.cachedEntry("claude-opus-5", deps).fresh, true,
    "a minute-old definitive negative must still be honored");
  reset();
});

test("a definitive-available verdict stays fresh indefinitely", function () {
  reset();
  var deps = probeDeps();
  writeCapability("claude-opus-5", deps, {
    available: true,
    definitive: true,
    reason: "exact-probe-success",
    resolvedModel: "claude-opus-5",
    attemptedAt: new Date(Date.now() - 90 * DAY_MS).toISOString(),
  });
  var cached = probe.cachedEntry("claude-opus-5", deps);
  assert.strictEqual(cached.fresh, true,
    "a proven-available model must not be re-probed: that costs a real query and " +
    "a revoked entitlement surfaces visibly at use time");
  assert.strictEqual(cached.available, true);
  reset();
});

test("a definitive negative with an unparseable timestamp is not treated as fresh", function () {
  reset();
  var deps = probeDeps();
  writeCapability("claude-opus-5", deps, {
    available: false, definitive: true, reason: "access-denied", attemptedAt: "not-a-date",
  });
  assert.strictEqual(probe.cachedEntry("claude-opus-5", deps).fresh, false,
    "a legacy entry with no usable timestamp must fail open to a re-probe");
  reset();
});

test("an expired definitive negative backs off after a failed re-probe", function () {
  reset();
  var deps = probeDeps();
  // rememberCapability keeps the original attemptedAt when a transient attempt
  // follows a definitive verdict, so this entry is permanently past its TTL.
  // Without a backoff it would re-probe on every catalog resolution.
  writeCapability("claude-opus-5", deps, {
    available: false,
    definitive: true,
    reason: "access-denied",
    attemptedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    lastAttempt: {
      available: false,
      definitive: false,
      reason: "transport",
      attemptedAt: new Date(Date.now() - 30 * 1000).toISOString(),
    },
  });
  assert.strictEqual(probe.cachedEntry("claude-opus-5", deps).fresh, true,
    "a re-probe that just failed transiently must suppress the next one");
  reset();
});

test("an expired definitive negative is re-probed again once the backoff lapses", function () {
  reset();
  var deps = probeDeps();
  writeCapability("claude-opus-5", deps, {
    available: false,
    definitive: true,
    reason: "access-denied",
    attemptedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    lastAttempt: {
      available: false,
      definitive: false,
      reason: "transport",
      attemptedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    },
  });
  assert.strictEqual(probe.cachedEntry("claude-opus-5", deps).fresh, false,
    "once the transient window has passed the model must become eligible again");
  reset();
});
