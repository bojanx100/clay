var test = require("node:test");
var assert = require("node:assert/strict");
var selectWorkerRoute = require("../lib/adaptive-worker-routing").selectWorkerRoute;

function routingState() {
  return {
    providerRoutes: [{
      id: "claude-anthropic", vendor: "claude", label: "Claude", enabled: true, health: "healthy",
    }, {
      id: "codex-openai", vendor: "codex", label: "Codex", enabled: true, health: "healthy",
    }, {
      id: "codex-github-copilot", vendor: "github-copilot", label: "Copilot", enabled: false, health: "healthy",
    }],
    modelsByVendor: {
      claude: ["claude-sonnet-4-6", "claude-opus-4-8"],
      codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      "github-copilot": ["gpt-5.6-sol"],
    },
  };
}

test("routine tasks use an efficient configured worker route", function () {
  var result = selectWorkerRoute(routingState(), {
    vendor: "codex", providerRouteId: "codex-openai", model: "gpt-5.6-sol",
  }, {
    title: "Add regression tests",
    objective: "Add bounded test coverage for the parser.",
  });
  assert.equal(result.tier, "routine");
  assert.equal(result.provider, "codex");
  assert.equal(result.model, "gpt-5.6-terra");
  assert.match(result.rationale, /Selected/);
});

test("security and architecture tasks promote to a strong model", function () {
  var result = selectWorkerRoute(routingState(), {
    vendor: "codex", providerRouteId: "codex-openai", model: "gpt-5.6-terra",
  }, {
    title: "Review authentication architecture",
    objective: "Threat model the new cross-cutting authorization boundary.",
  });
  assert.equal(result.tier, "strong");
  assert.equal(result.model, "gpt-5.6-sol");
});

test("explicit worker pins are never replaced", function () {
  var result = selectWorkerRoute(routingState(), {
    vendor: "codex", model: "gpt-5.6-sol",
  }, {
    provider: "claude",
    model: "claude-sonnet-4-6",
    providerPinned: true,
    modelPinned: true,
  });
  assert.equal(result.tier, "pinned");
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "claude-sonnet-4-6");
});

test("a provider-only pin still chooses a compatible model on that provider", function () {
  var result = selectWorkerRoute(routingState(), {
    vendor: "codex", model: "gpt-5.6-sol",
  }, {
    title: "Routine documentation",
    objective: "Update docs.",
    provider: "claude",
    providerPinned: true,
  });
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "claude-sonnet-4-6");
});

test("disabled routes are never selected", function () {
  var state = routingState();
  state.providerRoutes[0].enabled = false;
  state.providerRoutes[1].enabled = false;
  var result = selectWorkerRoute(state, {
    vendor: "claude", providerRouteId: "claude-anthropic", model: "best",
  }, {
    title: "Security review",
    objective: "Find vulnerabilities.",
  });
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "best");
  assert.match(result.rationale, /No other configured route/);
});
