// Content-free wall-clock accounting. Model time includes transport and any
// reasoning the provider does not expose; it is not a token-generation timer.
var fs = require("fs");
var path = require("path");
var config = require("./config");

function performanceFile() {
  return path.join(config.CONFIG_DIR, process.env.CLAY_DEV ? "turn-performance-dev.jsonl" : "turn-performance.jsonl");
}

function append(record) {
  // One small asynchronous append per turn; never rewrite session histories.
  fs.appendFile(performanceFile(), JSON.stringify(record) + "\n", function (error) {
    if (error) console.error("[TURN-PERF] append failed: " + error.code);
  });
}

function stamp(value) { return typeof value === "number" ? value : Date.now(); }

function configure(session, options, vendor) {
  session._performanceRoute = {
    vendor: session.vendor || vendor || null,
    model: options.model || session.model || null,
    effort: options.effort || null,
  };
  if (session._performanceTurn) Object.assign(session._performanceTurn.route, session._performanceRoute);
}

function begin(session, nowValue) {
  var now = stamp(nowValue);
  if (session._performanceTurn && !session._performanceTurn.finished) finish(session, "interrupted", now);
  var queuedAt = session._turnQueuedAt;
  session._turnQueuedAt = null;
  session._performanceTurn = {
    startedAt: now,
    lastAt: now,
    queueMs: typeof queuedAt === "number" && queuedAt <= now ? now - queuedAt : null,
    firstActivityMs: null,
    firstTextMs: null,
    providerWaitMs: 0,
    modelAndTransportMs: 0,
    toolMs: 0,
    verificationMs: 0,
    userWaitMs: 0,
    tools: {},
    toolCalls: 0,
    verificationCalls: 0,
    route: Object.assign({ vendor: session.vendor || null, model: session.model || null, effort: session.effort || null }, session._performanceRoute),
    resultSeen: false,
    failed: false,
    finished: false,
  };
  return session._performanceTurn;
}

function phase(state) {
  var tools = Object.values(state.tools);
  if (tools.some(function (tool) { return tool.kind === "userWaitMs"; })) return "userWaitMs";
  if (tools.some(function (tool) { return tool.kind === "verificationMs"; })) return "verificationMs";
  if (tools.length) return "toolMs";
  return state.firstActivityMs === null ? "providerWaitMs" : "modelAndTransportMs";
}

function advance(state, now) {
  state[phase(state)] += Math.max(0, now - state.lastAt);
  state.lastAt = Math.max(now, state.lastAt);
}

function toolKind(event) {
  var name = String(event.toolName || "");
  if (/AskUserQuestion|request_user_input|request_task_input|user_dialog/i.test(name)) return "userWaitMs";
  var input = event.input || event.toolInput || {};
  var command = typeof input === "string" ? input : input.command || input.cmd || input.code || "";
  // Best-effort classification of explicit test commands; unknown tools remain
  // tool time, never inferred verification success.
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+(?:--test|scripts\/run-tests\.js)\b|\b(?:pytest|vitest|jest)\b|\b(?:cargo|go)\s+test\b/.test(String(command).slice(0,4096))) {
    return "verificationMs";
  }
  return "toolMs";
}

function observe(session, event, nowValue) {
  var state = session._performanceTurn;
  if (!state || state.finished || !event) return;
  var now = stamp(nowValue);
  advance(state, now);
  var type = event.yokeType;
  if (/^(text_delta|thinking_delta|tool_input_delta|tool_start|tool_executing)$/.test(type || "") && state.firstActivityMs === null) {
    state.firstActivityMs = Math.max(0, now - state.startedAt);
  }
  if (type === "text_delta" && state.firstTextMs === null) state.firstTextMs = Math.max(0, now - state.startedAt);
  var id = event.toolId || event.blockId;
  // tool_start precedes argument generation; only execution consumes tool time.
  if (type === "tool_executing" && id) {
    var kind = toolKind(event);
    var previous = state.tools[id];
    if (!previous) state.toolCalls++;
    if (kind === "verificationMs" && (!previous || previous.kind !== kind)) state.verificationCalls++;
    state.tools[id] = { kind: previous && kind === "toolMs" ? previous.kind : kind };
  }
  if (type === "tool_result" && id) delete state.tools[id];
  if (type === "error") state.failed = true;
  if (type === "result") {
    state.resultSeen = true;
    if (event.isError || /error|failed/.test(event.subtype || "")) state.failed = true;
  }
}

function observeRecorded(session, event) {
  if (event.type !== "tool_executing" && event.type !== "tool_result") return;
  // Plan updates use a synthetic TodoWrite execution without a tool result.
  if (event.input && event.input.meta && event.input.meta.variant === "plan") return;
  observe(session, { yokeType: event.type, toolId: event.id,
    toolName: event.name, input: event.input }, event._ts);
}

function finish(session, outcome, nowValue, writer) {
  var state = session._performanceTurn;
  if (!state || state.finished) return null;
  var now = stamp(nowValue);
  advance(state, now);
  state.finished = true;
  var actualOutcome = outcome || (session.taskStopRequested || session.destroying ? "interrupted" :
    state.failed ? "failed" : state.resultSeen ? "completed" : "incomplete");
  var record = {
    schema: "clay.turn_performance.v1", phaseVersion: 2, at: now,
    sessionId: session.storageId || session.cliSessionId || String(session.localId),
    turnId: String(session.storageId || session.localId) + ":" + state.startedAt + ":" + (session._watchdogTurnSeq || 0),
    vendor: state.route.vendor || session.vendor || null, model: state.route.model, effort: state.route.effort,
    taskId: session.orchestrationParent && session.orchestrationParent.taskId || null,
    startedAt: state.startedAt, queueMs: state.queueMs,
    firstActivityMs: state.firstActivityMs, firstTextMs: state.firstTextMs,
    providerWaitMs: state.providerWaitMs, modelAndTransportMs: state.modelAndTransportMs,
    toolMs: state.toolMs, verificationMs: state.verificationMs, userWaitMs: state.userWaitMs,
    totalMs: Math.max(0, now - state.startedAt), toolCalls: state.toolCalls,
    verificationCalls: state.verificationCalls, outcome: actualOutcome,
    correctness: "unverified",
  };
  (writer || append)(record);
  return record;
}

module.exports = { begin: begin, configure: configure, observe: observe, observeRecorded: observeRecorded, finish: finish, performanceFile: performanceFile };
