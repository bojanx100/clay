// Behavioral eval coverage for Coop's connect-never-gatekeep rule.
var test = require("node:test");
var assert = require("node:assert");

var gatekeeping = require("../lib/lead-gatekeeping-eval");
var runner = require("../scripts/lead-gatekeeping-eval");

var target = { projectSlug: "clay", sessionStorageId: "sess_ward" };

function runtimeCase(overrides) {
  return Object.assign({
    id: "get_ward",
    ask: "get me Ward",
    channel: "text",
    expectedTarget: target,
    evidenceSource: "runtime_trace",
    trace: { events: [] },
  }, overrides || {});
}

function navigation(targetOverride) {
  return {
    kind: "navigation",
    action: "switch_session",
    target: targetOverride || target,
  };
}

test("recognizes explicit owner asks to get, open, or go to a worker/session", function () {
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("get me Ward"), true);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("get me Alice"), true);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("show me Alice Jones"), true);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("open the session working on X"), true);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("go to that worker"), true);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("summarize Ward's work"), false);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("get me a summary"), false);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("get me status"), false);
  assert.strictEqual(gatekeeping.isDirectHandoffAsk("show me the report"), false);
});

test("a generalized named target completes the same direct-handoff evaluation", function () {
  var result = gatekeeping.evaluateCase(runtimeCase({
    ask: "get me Alice",
    trace: { events: [navigation()] },
  }));
  assert.strictEqual(result.verdict, "GREEN");
  assert.strictEqual(result.assistantMiddlemanTurns, 0);
});

test("typed switch action is a direct handoff pass with zero middleman assistant turns", function () {
  var result = gatekeeping.evaluateCase(runtimeCase({ trace: { events: [navigation()] } }));
  assert.strictEqual(result.verdict, "GREEN");
  assert.strictEqual(result.pass, true);
  assert.strictEqual(result.assistantMiddlemanTurns, 0);
  assert.deepStrictEqual(result.directHandoff, {
    kind: "typed_navigation",
    action: "switch_session",
    target: target,
  });
});

test("clickable stable session reference is a direct handoff pass", function () {
  var result = gatekeeping.evaluateCase(runtimeCase({
    trace: { events: [{
      kind: "assistant",
      text: "",
      reference: { type: "session_ref", clickable: true, target: target },
    }] },
  }));
  assert.strictEqual(result.verdict, "GREEN");
  assert.strictEqual(result.assistantMiddlemanTurns, 0);
  assert.strictEqual(result.directHandoff.kind, "clickable_session_ref");
});

test("summary before a later handoff fails as a middleman turn", function () {
  var result = gatekeeping.evaluateCase(runtimeCase({
    trace: { events: [
      { kind: "assistant", text: "Ward finished the parser work and the tests are green." },
      navigation(),
    ] },
  }));
  assert.strictEqual(result.verdict, "RED");
  assert.strictEqual(result.assistantMiddlemanTurns, 1);
  assert.deepStrictEqual(result.reasonCodes, ["MIDDLEMAN_ASSISTANT_TURN"]);
});

test("summary-only response fails without a direct handoff", function () {
  var result = gatekeeping.evaluateCase(runtimeCase({
    trace: { events: [{ kind: "assistant", text: "Ward is working on the parser." }] },
  }));
  assert.strictEqual(result.verdict, "RED");
  assert.deepStrictEqual(result.reasonCodes, ["MIDDLEMAN_ASSISTANT_TURN", "NO_DIRECT_HANDOFF_EVIDENCE"]);
});

test("no matching session is a red result while absent live evidence is unmeasurable", function () {
  var noMatch = gatekeeping.evaluateCase(runtimeCase({ resolution: { status: "no_match" } }));
  var unavailable = gatekeeping.evaluateCase(gatekeeping.currentBaselineCase("/tmp/no-trace.json"));
  assert.strictEqual(noMatch.verdict, "RED");
  assert.deepStrictEqual(noMatch.reasonCodes, ["NO_MATCHING_SESSION"]);
  assert.strictEqual(unavailable.verdict, "UNMEASURABLE");
  assert.deepStrictEqual(unavailable.reasonCodes, ["MISSING_RUNTIME_EVIDENCE"]);
});

test("wrong project and wrong session have distinct deterministic reason codes", function () {
  var wrongProject = gatekeeping.evaluateCase(runtimeCase({
    trace: { events: [navigation({ projectSlug: "other", sessionStorageId: "sess_ward" })] },
  }));
  var wrongSession = gatekeeping.evaluateCase(runtimeCase({
    trace: { events: [navigation({ projectSlug: "clay", sessionStorageId: "sess_other" })] },
  }));
  assert.deepStrictEqual(wrongProject.reasonCodes, ["WRONG_PROJECT"]);
  assert.deepStrictEqual(wrongSession.reasonCodes, ["WRONG_SESSION"]);
});

test("malformed or static-only traces cannot manufacture a green result", function () {
  var malformed = gatekeeping.evaluateCase(runtimeCase({ trace: { events: "not-an-array" } }));
  var staticOnly = gatekeeping.evaluateCase(runtimeCase({
    evidenceSource: "static_contract",
    trace: { events: [navigation()] },
  }));
  assert.strictEqual(malformed.verdict, "UNMEASURABLE");
  assert.deepStrictEqual(malformed.reasonCodes, ["MALFORMED_TRACE"]);
  assert.strictEqual(staticOnly.verdict, "UNMEASURABLE");
  assert.deepStrictEqual(staticOnly.reasonCodes, ["STATIC_EVIDENCE_ONLY"]);
});

test("multiple cases aggregate typed counts and keep red or unmeasurable behavior visible", function () {
  var suite = gatekeeping.evaluateCases([
    runtimeCase({ id: "pass", trace: { events: [navigation()] } }),
    runtimeCase({ id: "summary", trace: { events: [{ kind: "assistant", text: "summary" }] } }),
    gatekeeping.currentBaselineCase("/tmp/no-trace.json"),
  ]);
  assert.strictEqual(suite.verdict, "RED");
  assert.deepStrictEqual(suite.counts, { total: 3, green: 1, red: 1, unmeasurable: 1 });
  assert.strictEqual(suite.reasons.MISSING_RUNTIME_EVIDENCE, 1);
  assert.strictEqual(suite.cases[0].assistantMiddlemanTurns, 0);
});

test("runtime adapter emits a durable-shaped gatekeeping_eval without model calls or UI actions", function () {
  var report = runner.evaluate({
    now: 1785800000000,
    cases: [runtimeCase({ trace: { events: [navigation()] } })],
  });
  assert.strictEqual(report.type, "gatekeeping_eval");
  assert.strictEqual(report.pass, true);
  assert.strictEqual(report.channel, "text");
  assert.strictEqual(report.cases[0].directHandoff.action, "switch_session");
  assert.match(gatekeeping.formatGatekeepingEvalLine(report), /gatekeeping GREEN/);
});
