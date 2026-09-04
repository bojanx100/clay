var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var health = require("../lib/lead-health");

var NOW = Date.parse("2026-08-04T12:00:00Z");

function line(obj) { return JSON.stringify(obj); }

test("parseHealthEvents keeps only well-formed provider_health lines", function () {
  var text = [
    line({ at: "2026-08-04T10:00:00Z", kind: "provider_health", vendor: "claude", from: "healthy", to: "unhealthy" }),
    line({ at: "2026-08-04T10:01:00Z", kind: "watchdog", sessionId: 1 }),
    "not json at all",
    line({ at: "bad-date", kind: "provider_health", vendor: "codex", to: "degraded" }),
    line({ at: "2026-08-04T11:00:00Z", kind: "provider_health", vendor: "codex", from: "healthy", to: "degraded" }),
  ].join("\n");
  var events = health.parseHealthEvents(text);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].vendor, "claude");
  assert.strictEqual(events[1].to, "degraded");
});

test("deriveHealth: last transition per vendor wins", function () {
  var events = health.parseHealthEvents([
    line({ at: "2026-08-04T09:00:00Z", kind: "provider_health", vendor: "claude", to: "unhealthy" }),
    line({ at: "2026-08-04T10:00:00Z", kind: "provider_health", vendor: "claude", to: "healthy" }),
    line({ at: "2026-08-04T11:00:00Z", kind: "provider_health", vendor: "claude", to: "unhealthy" }),
    line({ at: "2026-08-04T10:30:00Z", kind: "provider_health", vendor: "codex", to: "degraded" }),
  ].join("\n"));
  var snapshot = health.deriveHealth(events, { now: NOW });
  assert.deepStrictEqual(snapshot, { claude: "unhealthy", codex: "degraded" });
});

test("deriveHealth: stale transitions are dropped (assume healthy)", function () {
  var events = health.parseHealthEvents(
    line({ at: "2026-08-01T11:00:00Z", kind: "provider_health", vendor: "codex", to: "unhealthy" })
  );
  var snapshot = health.deriveHealth(events, { now: NOW });
  assert.deepStrictEqual(snapshot, {});
});

test("deriveHealth: expired quota windows are dropped immediately", function () {
  var failedAt = Date.parse("2026-08-04T11:00:00Z");
  var events = health.parseHealthEvents(line({
    at: "2026-08-04T11:00:00Z",
    kind: "provider_health",
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    scope: "route-model",
    unavailableUntil: failedAt + 1000,
    to: "unhealthy",
  }));
  var snapshot = health.deriveHealth(events, { now: NOW });
  assert.deepStrictEqual(snapshot, {});
  assert.strictEqual(health.healthForCandidate(snapshot, "codex", "codex-openai", "gpt-5.6-sol"), "healthy");
});

test("deriveHealth: a new provider session completed after failure proves recovery", function () {
  var failedAt = Date.parse("2026-08-04T11:00:00Z");
  var events = health.parseHealthEvents(
    line({ at: "2026-08-04T11:00:00Z", kind: "provider_health", vendor: "codex", to: "unhealthy" })
  );
  var snapshot = health.deriveHealth(events, {
    now: NOW,
    successes: [{ vendor: "codex", startedAt: failedAt + 1, at: failedAt + 2 }],
  });
  assert.deepStrictEqual(snapshot, { codex: "healthy" });
});

test("deriveHealth: an old in-flight session completion does not clear unavailability", function () {
  var failedAt = Date.parse("2026-08-04T11:00:00Z");
  var events = health.parseHealthEvents(
    line({ at: "2026-08-04T11:00:00Z", kind: "provider_health", vendor: "codex", to: "unhealthy" })
  );
  var snapshot = health.deriveHealth(events, {
    now: NOW,
    successes: [{ vendor: "codex", startedAt: failedAt - 1, at: failedAt + 2 }],
  });
  assert.deepStrictEqual(snapshot, { codex: "unhealthy" });
});

test("readHealthSnapshot reconciles a recent durable worker result without reading old sessions", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-health-"));
  var logPath = path.join(root, "recovery-events.log");
  var sessionsRoot = path.join(root, "sessions");
  var projectDir = path.join(sessionsRoot, "project");
  var failedAt = Date.parse("2026-08-04T11:00:00Z");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(logPath, line({
    at: "2026-08-04T11:00:00Z", kind: "provider_health", vendor: "codex", to: "unhealthy",
  }) + "\n");
  fs.writeFileSync(path.join(projectDir, "worker.jsonl"), [
    line({ type: "meta", vendor: "codex", createdAt: failedAt + 1 }),
    line({ type: "result", _ts: failedAt + 2 }),
    line({ type: "done", _ts: failedAt + 2 }),
  ].join("\n") + "\n");
  try {
    assert.deepStrictEqual(health.readHealthSnapshot(logPath, {
      now: NOW,
      sessionRoot: sessionsRoot,
    }), { codex: "healthy" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readHealthSnapshot reads session metadata when the first JSONL line is large", function () {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-health-"));
  var logPath = path.join(root, "recovery-events.log");
  var sessionsRoot = path.join(root, "sessions");
  var projectDir = path.join(sessionsRoot, "project");
  var failedAt = Date.parse("2026-08-04T11:00:00Z");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(logPath, line({
    at: "2026-08-04T11:00:00Z",
    kind: "provider_health",
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    scope: "route-model",
    to: "unhealthy",
  }) + "\n");
  fs.writeFileSync(path.join(projectDir, "worker.jsonl"), [
    line({
      type: "meta",
      vendor: "codex",
      providerRouteId: "codex-openai",
      model: "gpt-5.6-sol",
      createdAt: failedAt + 1,
      orchestrationContext: "x".repeat(3 * 1024 * 1024),
    }),
    line({ type: "user_message", _ts: failedAt + 1 }),
    line({ type: "result", _ts: failedAt + 2 }),
    line({ type: "done", _ts: failedAt + 2 }),
  ].join("\n") + "\n");
  try {
    var snapshot = health.readHealthSnapshot(logPath, {
      now: NOW,
      sessionRoot: sessionsRoot,
    });
    assert.strictEqual(snapshot[health.routeModelKey("codex-openai", "gpt-5.6-sol")], "healthy");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readHealthSnapshot returns empty map for a missing file", function () {
  assert.deepStrictEqual(health.readHealthSnapshot("/nonexistent/path.log"), {});
});

test("integration: unhealthy claude reroutes tier-4 work to codex", function () {
  var routing = require("../lib/lead-routing");
  var snapshot = health.deriveHealth(health.parseHealthEvents(
    line({ at: "2026-08-04T11:00:00Z", kind: "provider_health", vendor: "claude", to: "unhealthy" })
  ), { now: NOW });
  var route = routing.routeWorkItem({ taskClass: "design", risk: "high" }, { health: snapshot });
  assert.strictEqual(route.vendor, "codex");
  assert.strictEqual(route.tier, 4);
  assert.ok(/unavailable/.test(route.rationale));
});

test("deriveHealth keeps Fable quota separate from other native Claude models", function () {
  var failedAt = Date.parse("2026-08-04T11:00:00Z");
  var events = health.parseHealthEvents(line({
    at: "2026-08-04T11:00:00Z",
    kind: "provider_health",
    vendor: "claude",
    providerRouteId: "claude-anthropic",
    model: "fable",
    scope: "route-model",
    to: "unhealthy",
  }));
  var snapshot = health.deriveHealth(events, {
    now: NOW,
    successes: [{
      vendor: "claude",
      providerRouteId: "claude-anthropic",
      model: "claude-opus-4-8",
      startedAt: failedAt + 1,
      at: failedAt + 2,
    }],
  });
  assert.strictEqual(health.healthForCandidate(snapshot, "claude", "claude-anthropic", "claude-fable-5"), "unhealthy");
  assert.strictEqual(health.healthForCandidate(snapshot, "claude", "claude-anthropic", "claude-opus-4-8"), "healthy");
});

test("healthForCandidate maps a generic Lead Opus choice to concrete Opus health", function () {
  var snapshot = {
    "route:claude-anthropic|model:claude-opus-4-8": "unhealthy",
  };
  assert.strictEqual(health.healthForCandidate(snapshot, "claude", "claude-anthropic", "opus"), "unhealthy");
  assert.strictEqual(health.healthForCandidate(snapshot, "claude", "claude-anthropic", "sonnet"), "healthy");
});

test("a successful turn after an exact-route failure clears stale model health", function () {
  var failedAt = Date.parse("2026-08-04T11:00:00Z");
  var events = health.parseHealthEvents(line({
    at: "2026-08-04T11:00:00Z",
    kind: "provider_health",
    vendor: "codex",
    providerRouteId: "codex-openai",
    model: "gpt-5.6-sol",
    scope: "route-model",
    to: "unhealthy",
  }));
  var snapshot = health.deriveHealth(events, {
    now: NOW,
    successes: [{
      vendor: "codex",
      providerRouteId: "codex-openai",
      model: "gpt-5.6-sol",
      startedAt: failedAt + 1,
      at: failedAt + 2,
    }],
  });
  assert.strictEqual(health.healthForCandidate(snapshot, "codex", "codex-openai", "gpt-5.6-sol"), "healthy");
});

test("provider-wide outage still blocks every exact route candidate", function () {
  var snapshot = health.deriveHealth(health.parseHealthEvents(line({
    at: "2026-08-04T11:00:00Z",
    kind: "provider_health",
    vendor: "claude",
    scope: "vendor",
    to: "unhealthy",
  })), { now: NOW });
  assert.strictEqual(health.healthForCandidate(snapshot, "claude", "claude-anthropic", "claude-fable-5"), "unhealthy");
  assert.strictEqual(health.healthForCandidate(snapshot, "claude", "claude-anthropic", "claude-opus-4-8"), "unhealthy");
});
