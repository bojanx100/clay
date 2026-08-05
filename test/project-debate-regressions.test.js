var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var UUID_A = "aaaaaaaa-0000-0000-0000-000000000001";
var UUID_B = "bbbbbbbb-0000-0000-0000-000000000002";
var MODERATOR = "mate_cccc";
var PANELIST = "mate_" + UUID_A;
var TEAM = [
  { id: PANELIST, name: "Ward", status: "ready" },
  { id: "mate_" + UUID_B, name: "Arch", status: "ready" },
  { id: MODERATOR, name: "Clay", status: "ready", builtinKey: "clay" },
];

function clearModuleCache() {
  [
    "../lib/config",
    "../lib/mates",
    "../lib/project-debate-utils",
    "../lib/project-debate-flow",
    "../lib/project-debate-state",
    "../lib/project-debate",
  ].forEach(function (moduleName) {
    try { delete require.cache[require.resolve(moduleName)]; } catch (e) {}
  });
}

function makeHarness() {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-debate-regression-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  clearModuleCache();
  fs.mkdirSync(path.join(tmpHome, "mates"), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "mates", "mates.json"), JSON.stringify({ mates: TEAM }));

  var attachDebate = require("../lib/project-debate").attachDebate;
  var source = { localId: 1, history: [], debateState: null };
  var currentSession = source;
  var created = [];
  var sent = [];
  var createdMentionSessions = [];
  var pushedMessages = [];
  var profileById = {};
  TEAM.forEach(function (mate) { profileById[mate.id] = mate; });

  var sm = {
    sessions: [source],
    createSession: function () {
      var session = { localId: 100 + created.length, history: [], debateState: null };
      created.push(session);
      this.sessions.push(session);
      currentSession = session;
      return session;
    },
    saveSessionFile: function () {},
    switchSession: function () {},
    appendToSessionFile: function () {},
  };

  function createMentionSession(options) {
    createdMentionSessions.push(options);
    var mentionSession = {
      isAlive: function () { return true; },
      pushMessage: function (text, callbacks) {
        pushedMessages.push({ text: text, callbacks: callbacks });
      },
      close: function () {},
    };
    return Promise.resolve(mentionSession);
  }

  var ws = { _clayUser: null };
  var debate = attachDebate({
    cwd: tmpHome,
    slug: "regression-test",
    isMate: false,
    projectOwnerId: null,
    send: function (msg) { sent.push({ target: "all", msg: msg }); },
    sendTo: function (target, msg) { sent.push({ target: target, msg: msg }); },
    sendToSession: function (sessionId, msg) { sent.push({ target: sessionId, msg: msg }); },
    sm: sm,
    sdk: { createMentionSession: createMentionSession },
    getMateProfile: function (unusedMateCtx, mateId) {
      var mate = profileById[mateId] || { name: mateId };
      return {
        name: mate.name,
        bio: "test bio",
        avatarColor: "#000",
        avatarStyle: "bottts",
        avatarSeed: mateId,
      };
    },
    loadMateClaudeMd: function () { return ""; },
    loadMateDigests: function () { return ""; },
    hydrateImageRefs: function () {},
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
    getSessionForWs: function () { return currentSession; },
    updateMemorySummary: function () {},
    initMemorySummary: function () {},
  });

  return {
    debate: debate,
    source: source,
    ws: ws,
    created: created,
    sent: sent,
    createdMentionSessions: createdMentionSessions,
    pushedMessages: pushedMessages,
    current: function () { return currentSession; },
    latest: function (type) {
      for (var i = sent.length - 1; i >= 0; i--) {
        if (sent[i].msg.type === type) return sent[i].msg;
      }
      return null;
    },
    cleanup: function () {
      if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
      else delete process.env.CLAY_HOME;
      clearModuleCache();
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

function brief() {
  return {
    topic: "Should debates be durable?",
    format: "round_robin",
    context: "Restart and pause must preserve the brief.",
    specialRequests: "Keep it concise.",
    panelists: [{ mateId: PANELIST, role: "Operations", brief: "Argue for durable recovery." }],
  };
}

test("extracted debate validation, state, and phase decisions cover malformed and both-sided branches", function () {
  var flow = require("../lib/project-debate-flow");
  var state = require("../lib/project-debate-state");
  var resolve = function (mateId) { return mateId === PANELIST || mateId === MODERATOR ? mateId : null; };

  assert.strictEqual(flow.isActiveDebatePhase("preparing"), true);
  assert.strictEqual(flow.isActiveDebatePhase("reviewing"), true);
  assert.strictEqual(flow.isActiveDebatePhase("live"), true);
  assert.strictEqual(flow.isActiveDebatePhase("ended"), false);
  assert.deepStrictEqual(flow.normalizePanelists([null, { mateId: "missing" }, { mateId: PANELIST }], resolve), [{ mateId: PANELIST, role: "", brief: "" }]);
  assert.deepStrictEqual(flow.resolveParticipants("missing", [{ mateId: PANELIST }], resolve), { ok: false, reason: "moderator" });
  assert.deepStrictEqual(flow.resolveParticipants(MODERATOR, [{ mateId: "missing" }], resolve), { ok: false, reason: "panelists" });
  assert.deepStrictEqual(flow.resolveParticipants(MODERATOR, [{ mateId: PANELIST, role: "Ops" }], resolve), {
    ok: true,
    moderatorId: MODERATOR,
    panelists: [{ mateId: PANELIST, role: "Ops", brief: "" }],
  });

  var restored = state.createDebateState({ phase: "live", topic: "T", moderatorId: MODERATOR, panelists: [{ mateId: PANELIST }], mateCtx: {} });
  assert.strictEqual(restored.phase, "live");
  assert.strictEqual(restored.round, 1);
  assert.deepStrictEqual(state.panelistsFromBrief([{ mateId: PANELIST, role: "Ops" }]), [{ mateId: PANELIST, role: "Ops", brief: "" }]);
  assert.deepStrictEqual(flow.getPauseTransition(true, null), { action: "ack", paused: true, holding: false });
  assert.deepStrictEqual(flow.getPauseTransition(true, function () {}), { action: "ack", paused: true, holding: true });
  assert.deepStrictEqual(flow.getPauseTransition(false, function () {}), { action: "resume", paused: false, holding: false });
  assert.deepStrictEqual(flow.getConcludeResponse({ phase: "live", awaitingConcludeConfirm: true }, { action: "end" }), { ok: true, action: "end", wasEnded: false });
  assert.deepStrictEqual(flow.getConcludeResponse({ phase: "ended" }, { action: "continue" }), { ok: true, action: "continue", wasEnded: true });
  assert.deepStrictEqual(flow.getConcludeResponse({ phase: "live", awaitingConcludeConfirm: false }, { action: "end" }), { ok: false });
  assert.deepStrictEqual(flow.getConcludeResponse({ phase: "live", awaitingConcludeConfirm: true }, { action: "stale" }), { ok: false });
  assert.deepStrictEqual(flow.getConcludeResponse({ phase: "live", awaitingConcludeConfirm: true }, null), { ok: false });
});

test("headless module lifecycle records typed start, held turn, pause/resume, conclude, and restart events", async function () {
  var h = makeHarness();
  try {
    var result = h.debate.handleMcpDebateApproval(h.source, brief(), MODERATOR, h.ws);
    assert.deepStrictEqual(result, { ok: true });
    await Promise.resolve();
    assert.strictEqual(h.current()._debate.phase, "live");
    assert.strictEqual(h.createdMentionSessions.length, 1, "moderator mention session starts the lifecycle");

    h.debate.handleDebatePauseToggle(h.ws, { paused: true });
    h.createdMentionSessions[0].onDone("@Ward please give the operational view.");
    assert.deepStrictEqual(h.latest("debate_pause_state"), { type: "debate_pause_state", paused: true, holding: true });
    h.debate.handleDebatePauseToggle(h.ws, { paused: false });
    await Promise.resolve();
    assert.strictEqual(h.createdMentionSessions.length, 2, "resume releases the held panelist turn");
    assert.strictEqual(h.latest("debate_turn").mateId, PANELIST);

    h.createdMentionSessions[1].onDone("Durable recovery is safer.");
    assert.ok(h.pushedMessages.length > 0, "panelist response is fed back to the moderator");
    h.pushedMessages[h.pushedMessages.length - 1].callbacks.onDone("There are no further panelists to call.");
    assert.strictEqual(h.current()._debate.awaitingConcludeConfirm, true);
    assert.ok(h.latest("debate_conclude_confirm"));

    h.debate.handleDebateConcludeResponse(h.ws, { action: "end" });
    h.pushedMessages[h.pushedMessages.length - 1].callbacks.onDone("RECOMMENDATION: retain durable briefs.");
    var ended = h.latest("debate_ended");
    assert.ok(ended);
    assert.strictEqual(ended.reason, "natural");
    assert.strictEqual(ended.format, "round_robin");
    assert.strictEqual(ended.specialRequests, "Keep it concise.");

    h.debate.handleDebateStart(h.ws, {
      restartBrief: true,
      topic: ended.topic,
      format: ended.format,
      context: ended.context,
      specialRequests: ended.specialRequests,
      moderatorId: ended.moderatorId,
      panelists: ended.panelists,
    });
    await Promise.resolve();
    assert.strictEqual(h.current()._debate.phase, "live");
    assert.strictEqual(h.created.length, 2, "restart creates a fresh live session");
    assert.notStrictEqual(h.created[1].loop.loopId, h.created[0].loop.loopId);

    var typed = h.sent.map(function (entry) { return entry.msg; }).filter(function (msg) { return typeof msg.type === "string"; });
    ["debate_started", "debate_turn", "debate_pause_state", "debate_conclude_confirm", "debate_conclusion", "debate_ended"].forEach(function (type) {
      assert.ok(typed.some(function (msg) { return msg.type === type; }), "recorded typed event: " + type);
    });
  } finally {
    h.cleanup();
  }
});

test("MCP approval rejects missing, malformed, and already-active lifecycle inputs", function () {
  var h = makeHarness();
  try {
    var noSession = h.debate.handleMcpDebateApproval(null, brief(), MODERATOR, h.ws);
    assert.strictEqual(noSession.ok, false);
    var malformed = h.debate.handleMcpDebateApproval(h.source, { topic: "T", panelists: [{ mateId: "missing" }] }, MODERATOR, h.ws);
    assert.strictEqual(malformed.ok, false);
    assert.match(h.latest("debate_error").error, /None of the proposed panelists/);
    assert.deepStrictEqual(h.debate.handleMcpDebateApproval(h.source, brief(), MODERATOR, h.ws), { ok: true });
    var active = h.debate.handleMcpDebateApproval(h.current(), brief(), MODERATOR, h.ws);
    assert.strictEqual(active.ok, false);
    assert.match(h.latest("debate_error").error, /already active/);
  } finally {
    h.cleanup();
  }
});
