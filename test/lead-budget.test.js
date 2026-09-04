// Tests for daily Lead spend/usage aggregation and pressure derivation.
var test = require("node:test");
var assert = require("node:assert");

var budget = require("../lib/lead-budget");
var routing = require("../lib/lead-routing");
var standup = require("../lib/lead-standup");

var DAY = budget.DAY_MS;
var START = 1785800000000;

function result(at, cost, input, output, cacheRead, cacheWrite) {
  return {
    type: "result",
    _ts: at,
    cost: cost,
    usage: input === null ? null : {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead || 0,
      cache_creation_input_tokens: cacheWrite || 0,
    },
  };
}

test("daily aggregation groups recorded result spend and usage per vendor", function () {
  var daily = budget.aggregateDailyUsage([
    {
      vendor: "claude",
      createdAt: START - 100,
      history: [
        result(START - 1, 2, 50, 5),
        result(START + 10, 3.5, 100, 20, 30, 4),
        result(START + 20, 5, 200, 40, 60, 8),
        result(START + DAY, 8, 999, 999),
      ],
    },
    { vendor: "codex", createdAt: START, history: [result(START + 30, null, 500, 50, 100, 0)] },
  ], { dayStartAt: START, dayEndAt: START + DAY });

  assert.strictEqual(daily.type, "daily_vendor_usage");
  assert.strictEqual(daily.byVendor.claude.turns, 2);
  assert.strictEqual(daily.byVendor.claude.spendUsd, 3);
  assert.strictEqual(daily.byVendor.claude.inputTokens, 300);
  assert.strictEqual(daily.byVendor.claude.outputTokens, 60);
  assert.strictEqual(daily.byVendor.claude.cacheReadTokens, 90);
  assert.strictEqual(daily.byVendor.codex.turns, 1);
  assert.strictEqual(daily.byVendor.codex.spendAvailable, false);
  assert.strictEqual(daily.byVendor.codex.totalTokens, 550);
  assert.strictEqual(daily.totals.turns, 3);
  assert.strictEqual(daily.totals.totalTokens, 910);
  assert.strictEqual(daily.totals.spendComplete, false);
});

test("missing usage stays unknown and does not create budget pressure", function () {
  var daily = budget.buildDailyBudget([
    { vendor: "codex", history: [result(START + 1, null, null, null)] },
  ], {
    dayStartAt: START,
    dailySpendLimitUsd: 10,
    dailyTokenLimit: 1000,
    vendorCostRank: { codex: 1, claude: 2 },
  });
  assert.strictEqual(daily.dataAvailable, false);
  assert.strictEqual(daily.missingData, true);
  assert.strictEqual(daily.pressure.active, false);
  assert.strictEqual(daily.pressure.known, false);
  assert.ok(/unknown/.test(daily.pressure.reason));

  var route = routing.routeWorkItem({ taskClass: "debugging", risk: "low" }, {
    budgetPressure: daily.pressure,
  });
  assert.strictEqual(route.vendor, "claude", "unknown pressure must preserve default routing");
});

test("known partial usage can prove pressure only after crossing the threshold", function () {
  var below = budget.buildDailyBudget([
    { vendor: "codex", history: [result(START + 1, null, 700, 0)] },
    { vendor: "claude", history: [result(START + 2, null, null, null)] },
  ], { dayStartAt: START, dailyTokenLimit: 1000 });
  assert.strictEqual(below.pressure.active, false);
  assert.strictEqual(below.pressure.known, false);

  var above = budget.buildDailyBudget([
    { vendor: "codex", history: [result(START + 1, null, 850, 0)] },
    { vendor: "claude", history: [result(START + 2, null, null, null)] },
  ], { dayStartAt: START, dailyTokenLimit: 1000 });
  assert.strictEqual(above.pressure.active, true);
  assert.strictEqual(above.pressure.known, true);
  assert.strictEqual(above.pressure.ratio, 0.85);
});

test("composed typed usage drives routing and observable standup burn rate", function () {
  var daily = budget.buildDailyBudget([
    { vendor: "claude", createdAt: START, history: [result(START + 1, 1.25, 450, 50)] },
    { vendor: "codex", createdAt: START, history: [result(START + 2, null, 350, 50)] },
  ], {
    dayStartAt: START,
    dailyTokenLimit: 1000,
    pressureRatio: 0.8,
    vendorCostRank: { codex: 1, claude: 2 },
  });
  var route = routing.routeWorkItem({ taskClass: "debugging", risk: "low" }, {
    budgetPressure: daily.pressure,
  });
  var output = standup.composeStandup({
    now: START + 1000,
    events: [],
    canaries: { recoveryEvents: 0, wsHandlerErrors: 0 },
    budget: daily,
  });

  assert.strictEqual(daily.pressure.active, true);
  assert.strictEqual(route.vendor, "codex");
  assert.strictEqual(route.tier, 2);
  assert.ok(/budget pressure: cheaper capable vendor/.test(route.rationale));
  assert.ok(/burn rate today: claude \$1\.25, 500 tokens/.test(output.text));
  assert.ok(/codex spend unavailable, 400 tokens/.test(output.text));
  assert.ok(/budget pressure 90%/.test(output.text));
});
