var test = require("node:test");
var assert = require("node:assert");
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
