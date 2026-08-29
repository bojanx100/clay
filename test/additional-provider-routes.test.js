var test = require("node:test");
var assert = require("node:assert");

var providerRoutes = require("../lib/provider-routes");
var routing = require("../lib/adaptive-worker-routing");

function routingState(vendors, catalogs, profile) {
  return {
    availableVendors: vendors.slice(),
    installedVendors: vendors.slice(),
    verifiedModelsByRoute: catalogs,
    providerRoutingProfile: profile,
    workerRoutingPolicy: { profile: profile },
  };
}

test("additional provider routes require both installation and availability", function() {
  var routes = providerRoutes.listProviderRoutes(["kimi"], ["kimi"], {
    verifiedModelsByRoute: {
      "kimi-moonshot": { models: ["auto"], verified: true, source: "live-initialization" },
    },
  });
  var kimi = routes.filter(function(route) { return route.id === "kimi-moonshot"; })[0];
  var qwen = routes.filter(function(route) { return route.id === "qwen-alibaba"; })[0];
  assert.strictEqual(kimi.enabled, true);
  assert.strictEqual(kimi.catalogVerified, true);
  assert.strictEqual(qwen.enabled, false);
});

test("successful ACP initialization verifies the provider auto model token", function() {
  var route = providerRoutes.routeForId("kimi-moonshot");
  var catalog = providerRoutes.verifiedCatalogForRoute(route, {
    verifiedModelsByRoute: {
      "kimi-moonshot": { models: ["auto"], verified: true, source: "live-initialization" },
    },
  });
  assert.deepStrictEqual(catalog.models, ["auto"]);
  assert.strictEqual(catalog.source, "live-initialization");
});

test("free-endurance prefers a healthy free-allowance route above the capability floor", function() {
  var state = routingState(["codex", "kimi"], {
    "codex-openai": { models: ["gpt-5.4"], verified: true, source: "live" },
    "kimi-moonshot": { models: ["auto"], verified: true, source: "live-initialization" },
  }, "free-endurance");
  var decision = routing.selectWorkerRoute(state, { vendor: "codex" }, {
    objective: "Implement a bounded feature",
  });
  assert.strictEqual(decision.provider, "kimi");
  assert.strictEqual(decision.providerRouteId, "kimi-moonshot");
  assert.strictEqual(decision.model, "auto");
  assert.strictEqual(decision.routingProfile, "free-endurance");
});

test("best-available prefers capability over a free-allowance candidate", function() {
  var state = routingState(["codex", "qwen"], {
    "codex-openai": { models: ["gpt-5.5"], verified: true, source: "live" },
    "qwen-alibaba": { models: ["auto"], verified: true, source: "live-initialization" },
  }, "best-available");
  var decision = routing.selectWorkerRoute(state, { vendor: "codex" }, {
    objective: "Implement a bounded feature",
  });
  assert.strictEqual(decision.provider, "codex");
  assert.strictEqual(decision.model, "gpt-5.5");
  assert.strictEqual(decision.routingProfile, "best-available");
});

test("frontier work does not route to an unproven auto-model capability", function() {
  var state = routingState(["kimi"], {
    "kimi-moonshot": { models: ["auto"], verified: true, source: "live-initialization" },
  }, "free-endurance");
  var decision = routing.selectWorkerRoute(state, { vendor: "kimi" }, {
    objective: "Design a security architecture for a cross-cutting migration",
  });
  assert.strictEqual(decision.blocked, true);
  assert.strictEqual(decision.blockedReason, "capability_mismatch");
});

test("coordinator worker creation persists an additional provider route decision", function() {
  var state = routingState(["codex", "kimi"], {
    "codex-openai": { models: ["gpt-5.4"], verified: true, source: "live" },
    "kimi-moonshot": { models: ["auto"], verified: true, source: "live-initialization" },
  }, "free-endurance");
  var task = { objective: "Implement a bounded feature" };
  var session = routing.prepareWorkerSession(state, {
    ownerId: "owner-1",
    vendor: "codex",
    permissionMode: "default",
  }, task, "worker-storage-id");

  assert.strictEqual(session.vendor, "kimi");
  assert.strictEqual(session.providerRouteId, "kimi-moonshot");
  assert.strictEqual(session.model, "auto");
  assert.strictEqual(task.provider, "kimi");
  assert.strictEqual(task.providerRouteId, "kimi-moonshot");
  assert.strictEqual(task.routingProfile, "free-endurance");
  assert.match(task.routingRationale, /Kimi Code/);
});
