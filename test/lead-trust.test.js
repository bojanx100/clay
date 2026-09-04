// Tests for per-decision-class × channel trust evidence.
var test = require("node:test");
var assert = require("node:assert");

var trust = require("../lib/lead-trust");

function observation(overrides) {
  var value = {
    type: "trust_observation",
    at: 100,
    decisionClass: "implementation",
    channel: "text",
    metric: "gate_pass",
    outcome: true,
    evidence: "typed test evidence",
  };
  for (var key in (overrides || {})) value[key] = overrides[key];
  return value;
}

function allMetrics(overrides) {
  return trust.METRICS.map(function (metric) {
    return observation({ metric: metric, at: overrides.at++, channel: overrides.channel });
  });
}

test("trust observations validate the typed schema", function () {
  var valid = trust.validateTrustObservation(observation());
  assert.strictEqual(valid.valid, true);
  assert.strictEqual(valid.value.channel, "text");
  assert.strictEqual(trust.validateTrustObservation(observation({ decisionClass: "bogus" })).valid, false);
  assert.strictEqual(trust.validateTrustObservation(observation({ channel: "email" })).valid, false);
  assert.strictEqual(trust.validateTrustObservation(observation({ metric: "coverage" })).valid, false);
  assert.strictEqual(trust.validateTrustObservation(observation({ outcome: 1 })).valid, false);
  assert.strictEqual(trust.validateTrustObservation(observation({ at: "100" })).valid, false);
  assert.strictEqual(trust.validateTrustObservation(observation({ evidence: " " })).valid, false);
});

test("legacy channel-less trust observations normalize to text only", function () {
  var legacy = observation({ channel: undefined });
  delete legacy.channel;
  var normalized = trust.normalizeTrustObservation(legacy);
  assert.strictEqual(normalized.channel, "text");
  assert.strictEqual(trust.normalizeTrustObservation({
    type: "completed", decisionClass: "implementation", metric: "gate_pass",
    outcome: true, at: 100, evidence: "completion evidence",
  }), null);
});

test("aggregation keeps decision classes and channels isolated and emits all metrics", function () {
  var input = [
    observation({ outcome: true }),
    observation({ outcome: false, at: 101 }),
    observation({ channel: "voice", outcome: true, at: 102 }),
    observation({ decisionClass: "security", outcome: true, at: 103 }),
    observation({ metric: "backtest_alignment", outcome: true, at: 104 }),
    observation({ metric: "refusal_correctness", outcome: false, at: 105 }),
    observation({ channel: "email" }),
    { type: "completed", metric: "gate_pass", outcome: true, at: 106, evidence: "not trust" },
  ];
  var aggregate = trust.aggregateTrustObservations(input);
  assert.strictEqual(aggregate.observations, 6);
  assert.strictEqual(aggregate.skipped, 2);
  assert.deepStrictEqual(aggregate.groups.map(function (group) {
    return group.decisionClass + "/" + group.channel;
  }), ["implementation/text", "implementation/voice", "security/text"]);
  var text = aggregate.byDecisionClassChannel.implementation.text;
  assert.deepStrictEqual(text.metrics.gate_pass, { count: 2, passCount: 1, rate: 50, ratePct: 50 });
  assert.deepStrictEqual(text.metrics.backtest_alignment, { count: 1, passCount: 1, rate: 100, ratePct: 100 });
  assert.deepStrictEqual(text.metrics.refusal_correctness, { count: 1, passCount: 0, rate: 0, ratePct: 0 });
  assert.strictEqual(aggregate.byDecisionClassChannel.implementation.voice.metrics.gate_pass.count, 1);
  assert.strictEqual(aggregate.byDecisionClassChannel.security.text.metrics.gate_pass.count, 1);
  assert.strictEqual(text.metrics.gate_pass.count, 2);
});

test("promotion needs an injected policy and exact pair samples", function () {
  var observations = [].concat(allMetrics({ channel: "text", at: 200 }));
  var aggregate = trust.aggregateTrustObservations(observations);
  var policy = {
    minimumSamples: 1,
    thresholds: { gate_pass: 0.9, backtest_alignment: 0.9, refusal_correctness: 0.9 },
  };
  assert.strictEqual(trust.isPromotionEligible(aggregate, "implementation", "text", null), false);
  var eligible = trust.evaluatePromotionEligibility(aggregate, "implementation", "text", policy);
  assert.strictEqual(eligible.eligible, true);
  assert.strictEqual(eligible.canAutoPromote, true);
  assert.strictEqual(trust.isPromotionEligible(aggregate, "implementation", "voice", policy), false);
  assert.strictEqual(
    trust.evaluatePromotionEligibility(aggregate, "implementation", "voice", policy).reason,
    "insufficient_samples",
  );
});

test("voice can have stricter pair-specific thresholds and minimum samples", function () {
  var observations = [].concat(allMetrics({ channel: "text", at: 300 }));
  observations = observations.concat(allMetrics({ channel: "voice", at: 400 }));
  var aggregate = trust.aggregateTrustObservations(observations);
  var policy = {
    minimumSamples: 1,
    thresholds: { gate_pass: 0.5, backtest_alignment: 0.5, refusal_correctness: 0.5 },
    pairs: {
      "implementation:voice": {
        minimumSamples: 2,
        thresholds: { gate_pass: 1, backtest_alignment: 1, refusal_correctness: 1 },
      },
    },
  };
  assert.strictEqual(trust.isPromotionEligible(aggregate, "implementation", "text", policy), true);
  var voice = trust.evaluatePromotionEligibility(aggregate, "implementation", "voice", policy);
  assert.strictEqual(voice.eligible, false);
  assert.strictEqual(voice.reason, "insufficient_samples");
});

test("trust report and formatting are deterministic", function () {
  var report = trust.composeTrustReport([
    observation({ metric: "refusal_correctness", outcome: false, at: 3 }),
    observation({ metric: "gate_pass", at: 1 }),
    observation({ metric: "backtest_alignment", at: 2 }),
  ]);
  assert.strictEqual(report.policySupplied, false);
  assert.strictEqual(report.pass, null);
  assert.match(trust.formatTrustReport(report), /implementation\/text/);
  assert.match(trust.formatTrustReport(report), /gate_pass 1\/1 \(100%\)/);
  assert.match(trust.formatTrustReport(report), /backtest_alignment 1\/1 \(100%\)/);
  assert.match(trust.formatTrustReport(report), /refusal_correctness 0\/1 \(0%\)/);
});

test("explicit pair policy reports unobserved channels as held", function () {
  var policy = {
    minimumSamples: 1,
    thresholds: { gate_pass: 0, backtest_alignment: 0, refusal_correctness: 0 },
    classes: {
      implementation: {
        text: {},
        voice: {},
      },
    },
  };
  var report = trust.composeTrustReport(allMetrics({ channel: "text", at: 500 }), policy);
  assert.strictEqual(report.promotionEligible.length, 2);
  assert.strictEqual(report.promotionEligible[0].channel, "text");
  assert.strictEqual(report.promotionEligible[1].channel, "voice");
  assert.strictEqual(report.promotionEligible[1].reason, "insufficient_samples");
  assert.strictEqual(report.pass, false);
});
