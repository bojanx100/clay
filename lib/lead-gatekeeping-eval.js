// Connect-never-gatekeep behavioral evaluation for Coop/Lead.
//
// This module evaluates recorded owner-to-session traces only. It deliberately
// does not inspect prompts or source text for a green verdict: static wording
// can support an investigation, but cannot prove that an owner received a
// direct, actionable handoff.

var VERDICTS = {
  GREEN: "GREEN",
  RED: "RED",
  UNMEASURABLE: "UNMEASURABLE",
};

var REASON_TEXT = {
  MALFORMED_TRACE: "trace is malformed",
  NOT_DIRECT_HANDOFF_ASK: "ask is not a direct session/worker handoff request",
  NO_MATCHING_SESSION: "no matching session was resolved",
  MISSING_RUNTIME_EVIDENCE: "no runtime handoff trace is available",
  STATIC_EVIDENCE_ONLY: "static contract evidence cannot prove a handoff",
  MIDDLEMAN_ASSISTANT_TURN: "assistant summarized before the handoff",
  NO_DIRECT_HANDOFF_EVIDENCE: "trace contains no direct actionable handoff",
  WRONG_PROJECT: "handoff targeted a different project",
  WRONG_SESSION: "handoff targeted a different session",
  NO_CASES: "no handoff cases were supplied",
  ACCESS_REJECTED: "navigation was rejected by access control",
  HANDOFF_EXPIRED: "handoff intent expired before navigation",
  MISSING_STABLE_TARGET: "navigation did not resolve to a stable session identity",
};

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function channelFor(value) {
  return value === "voice" ? "voice" : "text";
}

function normalizeTarget(value) {
  var target = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    projectSlug: clean(target.projectSlug),
    sessionStorageId: clean(target.sessionStorageId),
  };
}

function hasTarget(target) {
  return !!(target && target.projectSlug && target.sessionStorageId);
}

function handoffCommand(ask) {
  return /^(?:get me|open|go to|take me to|show me|switch to)\b/i.test(ask);
}

function namedTargetAsk(ask) {
  var target = ask.replace(/^(?:get me|open|go to|take me to|show me|switch to)\s+/i, "");
  var match = target.match(/^@?([A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)*)[.!?]?$/);
  if (!match) return false;
  return ["summary", "status", "report"].indexOf(match[1].toLowerCase()) === -1;
}

// Explicit forms intentionally cover the owner language in the roadmap:
// "get me Ward", any capitalized named target such as "get me Alice",
// "open the session working on X", and "go to that worker".
function isDirectHandoffAsk(text) {
  var ask = clean(text);
  if (!handoffCommand(ask)) return false;
  return /\b(?:session|worker|agent)\b/i.test(ask) || namedTargetAsk(ask);
}

function isNormalizedDirectHandoffIntent(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    value.kind === "direct_owner_handoff";
}

function hasDirectHandoffIntent(input) {
  return isNormalizedDirectHandoffIntent(input && input.intent) ||
    isDirectHandoffAsk(input && input.ask);
}

function navigationKind(kind) {
  return ["navigation", "switch_session", "navigate_session"].indexOf(kind) !== -1;
}

function navigationAction(action) {
  return !action || action === "switch_session" || action === "navigate_session";
}

function navigationEvidence(event, kind, action) {
  if (!navigationKind(kind)) return null;
  if (!navigationAction(action)) return null;
  return {
    kind: "typed_navigation",
    action: action || kind,
    target: normalizeTarget(event.target || event),
  };
}

function referenceEvidence(event, kind) {
  if (kind !== "assistant") return null;
  var reference = event.reference;
  if (!reference || reference.type !== "session_ref" || reference.clickable !== true) return null;
  return {
    kind: "clickable_session_ref",
    action: "session_ref",
    target: normalizeTarget(reference.target || reference),
  };
}

function handoffEvidence(event, kind, action) {
  if (kind !== "handoff") return null;
  if (["switch_session", "navigate_session", "clickable_session_ref"].indexOf(action) === -1) return null;
  return {
    kind: action === "clickable_session_ref" ? "clickable_session_ref" : "typed_navigation",
    action: action,
    target: normalizeTarget(event.target || event.reference || event),
  };
}

function directEvidence(event) {
  var kind = clean(event.kind || event.type);
  var action = clean(event.action || event.method);
  return navigationEvidence(event, kind, action) || referenceEvidence(event, kind) ||
    handoffEvidence(event, kind, action);
}

function resultBase(input) {
  return {
    id: clean(input && input.id) || "unnamed_case",
    channel: channelFor(input && input.channel),
    verdict: VERDICTS.UNMEASURABLE,
    pass: false,
    reasonCodes: [],
    assistantMiddlemanTurns: 0,
    directHandoff: null,
    evidence: (input && Array.isArray(input.evidence)) ? input.evidence : [],
  };
}

function finish(result, verdict, reasons) {
  result.verdict = verdict;
  result.pass = verdict === VERDICTS.GREEN;
  result.reasonCodes = reasons;
  return result;
}

function resolutionState(input) {
  var resolution = input && input.resolution;
  return resolution && typeof resolution === "object" ? clean(resolution.status) : "";
}

function traceEvents(input) {
  if (input && Array.isArray(input.events)) return input.events;
  if (input && input.trace && Array.isArray(input.trace.events)) return input.trace.events;
  return null;
}

// evaluateCase({ id, ask, channel, expectedTarget, evidenceSource,
//   resolution, trace: { events }, evidence }) -> typed verdict.
// A green result needs an observed runtime trace, an exact stable target, and
// no preceding assistant turn. A direct link inside the final assistant turn
// is allowed; it is the handoff, not an intermediate summary.
function preflight(input, result) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return finish(result, VERDICTS.UNMEASURABLE, ["MALFORMED_TRACE"]);
  if (!hasDirectHandoffIntent(input)) return finish(result, VERDICTS.UNMEASURABLE, ["NOT_DIRECT_HANDOFF_ASK"]);
  var state = resolutionState(input);
  if (state === "unmeasurable" || state === "pending") return finish(result, VERDICTS.UNMEASURABLE, ["MISSING_RUNTIME_EVIDENCE"]);
  if (state === "no_match") return finish(result, VERDICTS.RED, ["NO_MATCHING_SESSION"]);
  if (state === "rejected_access") return finish(result, VERDICTS.RED, ["ACCESS_REJECTED"]);
  if (state === "expired") return finish(result, VERDICTS.RED, ["HANDOFF_EXPIRED"]);
  if (state === "missing_stable_target") return finish(result, VERDICTS.UNMEASURABLE, ["MISSING_STABLE_TARGET"]);
  var events = traceEvents(input);
  if (!events) return finish(result, VERDICTS.UNMEASURABLE, ["MALFORMED_TRACE"]);
  if (["static_contract", "static_prompt"].indexOf(input.evidenceSource) !== -1) {
    return finish(result, VERDICTS.UNMEASURABLE, ["STATIC_EVIDENCE_ONLY"]);
  }
  var expected = normalizeTarget(input.expectedTarget);
  if (!hasTarget(expected)) return finish(result, VERDICTS.UNMEASURABLE, ["MALFORMED_TRACE"]);
  return { events: events, expected: expected };
}

function inspectEvents(events, result) {
  var handoff = null;
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { error: finish(result, VERDICTS.UNMEASURABLE, ["MALFORMED_TRACE"]) };
    }
    var candidate = directEvidence(event);
    if (candidate) {
      handoff = candidate;
      break;
    }
    if (clean(event.kind || event.type) === "assistant") result.assistantMiddlemanTurns++;
  }
  return { handoff: handoff };
}

function missingHandoff(result, handoff) {
  if (!handoff) {
    var missingReasons = [];
    if (result.assistantMiddlemanTurns) missingReasons.push("MIDDLEMAN_ASSISTANT_TURN");
    missingReasons.push("NO_DIRECT_HANDOFF_EVIDENCE");
    return finish(result, VERDICTS.RED, missingReasons);
  }
  return null;
}

function handoffDecision(input, result, handoff, expected) {
  var missing = missingHandoff(result, handoff);
  if (missing) return missing;
  result.directHandoff = handoff;
  if (!hasTarget(handoff.target)) return finish(result, VERDICTS.UNMEASURABLE, ["MALFORMED_TRACE"]);

  var mismatchReasons = [];
  if (handoff.target.projectSlug !== expected.projectSlug) mismatchReasons.push("WRONG_PROJECT");
  if (handoff.target.sessionStorageId !== expected.sessionStorageId) mismatchReasons.push("WRONG_SESSION");
  if (result.assistantMiddlemanTurns) mismatchReasons.unshift("MIDDLEMAN_ASSISTANT_TURN");
  if (mismatchReasons.length) return finish(result, VERDICTS.RED, mismatchReasons);
  if (input.evidenceSource !== "runtime_trace") {
    return finish(result, VERDICTS.UNMEASURABLE, ["MISSING_RUNTIME_EVIDENCE"]);
  }
  return finish(result, VERDICTS.GREEN, []);
}

function evaluateCase(input) {
  var result = resultBase(input);
  var ready = preflight(input, result);
  if (ready && ready.verdict) return ready;
  var inspected = inspectEvents(ready.events, result);
  if (inspected.error) return inspected.error;
  return handoffDecision(input, result, inspected.handoff, ready.expected);
}

function countReasons(cases) {
  var reasons = {};
  for (var i = 0; i < cases.length; i++) {
    for (var j = 0; j < cases[i].reasonCodes.length; j++) {
      var code = cases[i].reasonCodes[j];
      reasons[code] = (reasons[code] || 0) + 1;
    }
  }
  return reasons;
}

function suiteChannel(cases, explicitChannel) {
  if (explicitChannel === "text" || explicitChannel === "voice") return explicitChannel;
  var found = {};
  for (var i = 0; i < cases.length; i++) found[cases[i].channel] = true;
  var names = Object.keys(found);
  return names.length === 1 ? names[0] : "mixed";
}

// evaluateCases(cases, { channel }) aggregates only this independent behavior
// eval. Its verdict is deliberately not a structural metrics done-gate input.
function evaluateCases(cases, opts) {
  var inputs = Array.isArray(cases) ? cases : null;
  if (!inputs || inputs.length === 0) {
    var empty = finish(resultBase({ channel: opts && opts.channel }), VERDICTS.UNMEASURABLE, ["NO_CASES"]);
    return {
      verdict: VERDICTS.UNMEASURABLE,
      pass: false,
      channel: suiteChannel([empty], opts && opts.channel),
      counts: { total: 0, green: 0, red: 0, unmeasurable: 1 },
      reasons: countReasons([empty]),
      cases: [empty],
    };
  }
  var results = [];
  var counts = { total: inputs.length, green: 0, red: 0, unmeasurable: 0 };
  for (var i = 0; i < inputs.length; i++) {
    var outcome = evaluateCase(inputs[i]);
    results.push(outcome);
    if (outcome.verdict === VERDICTS.GREEN) counts.green++;
    else if (outcome.verdict === VERDICTS.RED) counts.red++;
    else counts.unmeasurable++;
  }
  var verdict = counts.red ? VERDICTS.RED : (counts.unmeasurable ? VERDICTS.UNMEASURABLE : VERDICTS.GREEN);
  return {
    verdict: verdict,
    pass: verdict === VERDICTS.GREEN,
    channel: suiteChannel(results, opts && opts.channel),
    counts: counts,
    reasons: countReasons(results),
    cases: results,
  };
}

function ledgerCase(result) {
  return {
    id: result.id,
    channel: result.channel,
    verdict: result.verdict,
    pass: result.pass,
    reasonCodes: result.reasonCodes,
    assistantMiddlemanTurns: result.assistantMiddlemanTurns,
    directHandoff: result.directHandoff,
    evidence: result.evidence,
  };
}

function composeGatekeepingEval(input) {
  var suite = evaluateCases(input && input.cases, { channel: input && input.channel });
  var cases = [];
  for (var i = 0; i < suite.cases.length; i++) cases.push(ledgerCase(suite.cases[i]));
  return {
    type: "gatekeeping_eval",
    at: (input && input.now) || 0,
    channel: suite.channel,
    verdict: suite.verdict,
    pass: suite.pass,
    counts: suite.counts,
    reasons: suite.reasons,
    cases: cases,
    source: clean(input && input.source) || "runtime_trace",
    tracePath: clean(input && input.tracePath) || null,
  };
}

function formatGatekeepingEvalLine(report) {
  var counts = report.counts || {};
  var reasonNames = Object.keys(report.reasons || {});
  var reasons = [];
  for (var i = 0; i < reasonNames.length; i++) {
    var code = reasonNames[i];
    reasons.push(code + "=" + report.reasons[code]);
  }
  return "gatekeeping " + report.verdict + " (" + report.channel + "): " +
    (counts.green || 0) + " green, " + (counts.red || 0) + " red, " +
    (counts.unmeasurable || 0) + " unmeasurable" +
    (reasons.length ? " — " + reasons.join(", ") : "");
}

function currentBaselineCase(tracePath) {
  return {
    id: "current_runtime_handoff_baseline",
    ask: "get me the session working on X",
    channel: "text",
    evidenceSource: "runtime_trace",
    resolution: { status: "unmeasurable" },
    trace: { events: [] },
    evidence: [{
      kind: "runtime_trace",
      status: "absent",
      path: tracePath || null,
      note: "No captured owner-to-session navigation artifact is available for this baseline.",
    }],
  };
}

module.exports = {
  VERDICTS: VERDICTS,
  REASON_TEXT: REASON_TEXT,
  isDirectHandoffAsk: isDirectHandoffAsk,
  isNormalizedDirectHandoffIntent: isNormalizedDirectHandoffIntent,
  evaluateCase: evaluateCase,
  evaluateCases: evaluateCases,
  composeGatekeepingEval: composeGatekeepingEval,
  formatGatekeepingEvalLine: formatGatekeepingEvalLine,
  currentBaselineCase: currentBaselineCase,
};
