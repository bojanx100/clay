var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var UUID_A = "aaaaaaaa-0000-0000-0000-000000000001";
var UUID_B = "bbbbbbbb-0000-0000-0000-000000000002";
var TEAM = [
  { id: "mate_" + UUID_A, name: "Arch", status: "ready" },
  { id: "mate_" + UUID_B, name: "Ward", status: "ready" },
  { id: "mate_cccc", name: "Clay", status: "ready", builtinKey: "clay" },
];

function clearModuleCache() {
  ["../lib/config", "../lib/mates", "../lib/project-debate-utils", "../lib/project-debate"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (e) {}
  });
}

function makeDebateState(mateCtx) {
  return {
    phase: "live",
    topic: "Should Clay retain debate briefs?",
    format: "round_robin",
    context: "A prior debate was stopped or ended after a daemon restart.",
    specialRequests: "Keep the discussion concise.",
    moderatorId: "mate_cccc",
    panelists: [
      { mateId: "mate_" + UUID_A, role: "Architecture", brief: "Argue for durable state." },
      { mateId: "mate_" + UUID_B, role: "Operations", brief: "Argue for simple recovery." },
    ],
    mateCtx: mateCtx,
    moderatorSession: null,
    panelistSessions: {},
    nameMap: {},
    turnInProgress: false,
    pendingComment: null,
    round: 3,
    history: [],
    debateId: "debate_original",
    ownerId: null,
  };
}

function makeHarness() {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-debate-restart-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  clearModuleCache();

  var matesDir = path.join(tmpHome, "mates");
  fs.mkdirSync(matesDir, { recursive: true });
  fs.writeFileSync(path.join(matesDir, "mates.json"), JSON.stringify({ mates: TEAM }));

  var matesModule = require("../lib/mates");
  var attachDebate = require("../lib/project-debate").attachDebate;
  var mateCtx = matesModule.buildMateCtx(null);
  var source = { localId: 1, history: [], debateState: null };
  var created = [];
  var sent = [];
  var sm = {
    sessions: [source],
    createSession: function () {
      var session = { localId: 100 + created.length, history: [], debateState: null };
      created.push(session);
      this.sessions.push(session);
      return session;
    },
    saveSessionFile: function () {},
    switchSession: function () {},
    appendToSessionFile: function () {},
  };
  var profileById = {};
  for (var i = 0; i < TEAM.length; i++) profileById[TEAM[i].id] = TEAM[i];
  var ws = { _clayUser: null };
  var debate = attachDebate({
    cwd: tmpHome,
    slug: "restart-test",
    isMate: false,
    projectOwnerId: null,
    send: function (msg) { sent.push({ target: "all", msg: msg }); },
    sendTo: function (target, msg) { sent.push({ target: target, msg: msg }); },
    sendToSession: function (sessionId, msg) { sent.push({ target: sessionId, msg: msg }); },
    sm: sm,
    sdk: {
      createMentionSession: function () {
        return Promise.resolve({ isAlive: function () { return true; } });
      },
    },
    getMateProfile: function (unusedMateCtx, mateId) {
      var mate = profileById[mateId] || { name: mateId };
      return { name: mate.name, avatarColor: "#000", avatarStyle: "bottts", avatarSeed: mateId };
    },
    loadMateClaudeMd: function () { return ""; },
    loadMateDigests: function () { return ""; },
    hydrateImageRefs: function () {},
    onProcessingChanged: function () {},
    getLinuxUserForSession: function () { return null; },
    getSessionForWs: function () { return source; },
    updateMemorySummary: function () {},
    initMemorySummary: function () {},
  });

  return {
    debate: debate,
    mateCtx: mateCtx,
    source: source,
    created: created,
    sent: sent,
    ws: ws,
    cleanup: function () {
      if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
      else delete process.env.CLAY_HOME;
      clearModuleCache();
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

function latestMessage(harness, type) {
  for (var i = harness.sent.length - 1; i >= 0; i--) {
    if (harness.sent[i].msg.type === type) return harness.sent[i].msg;
  }
  return null;
}

function restartFromEndedBrief(harness, ended) {
  harness.debate.handleDebateStart(harness.ws, {
    type: "debate_start",
    restartBrief: true,
    topic: ended.topic,
    format: ended.format,
    context: ended.context,
    specialRequests: ended.specialRequests,
    moderatorId: ended.moderatorId,
    panelists: ended.panelists,
  });
}

test("user-stopped debate exposes its persisted brief and restarts as a fresh debate", function (t) {
  var h = makeHarness();
  try {
    h.source._debate = makeDebateState(h.mateCtx);
    h.debate.handleDebateStop(h.ws);

    var ended = latestMessage(h, "debate_ended");
    assert.ok(ended, "stopping a debate emits debate_ended");
    assert.strictEqual(ended.reason, "user_stopped");
    assert.deepStrictEqual(ended.panelists, makeDebateState(h.mateCtx).panelists);
    assert.strictEqual(ended.format, "round_robin");
    assert.strictEqual(ended.specialRequests, "Keep the discussion concise.");

    restartFromEndedBrief(h, ended);

    assert.strictEqual(h.created.length, 1, "restart creates a new debate session");
    var started = h.created[0].history.find(function (entry) { return entry.type === "debate_started"; });
    assert.ok(started, "fresh session records debate_started");
    assert.strictEqual(started.topic, ended.topic);
    assert.strictEqual(started.format, ended.format);
    assert.strictEqual(started.context, ended.context);
    assert.strictEqual(started.specialRequests, ended.specialRequests);
    assert.deepStrictEqual(
      started.panelists.map(function (panelist) { return { mateId: panelist.mateId, role: panelist.role, brief: panelist.brief }; }),
      ended.panelists
    );
    assert.notStrictEqual(h.created[0].loop.loopId, "debate_original", "restart uses a fresh debate id");
    t.diagnostic("restart state: " + JSON.stringify({
      endedReason: ended.reason,
      startedTopic: started.topic,
      startedFormat: started.format,
      startedPanelists: started.panelists.map(function (panelist) { return panelist.mateId; }),
      specialRequests: started.specialRequests,
    }));
  } finally {
    h.cleanup();
  }
});

test("naturally ended debates expose the same restart brief", function (t) {
  var h = makeHarness();
  try {
    h.source._debate = makeDebateState(h.mateCtx);
    h.source._debate.awaitingConcludeConfirm = true;
    h.debate.handleDebateConcludeResponse(h.ws, { action: "end" });

    var ended = latestMessage(h, "debate_ended");
    assert.ok(ended, "natural conclusion emits debate_ended");
    assert.strictEqual(ended.reason, "natural");
    assert.strictEqual(ended.topic, "Should Clay retain debate briefs?");
    assert.strictEqual(ended.moderatorId, "mate_cccc");
    assert.strictEqual(ended.panelists.length, 2);
    assert.strictEqual(ended.panelists[0].brief, "Argue for durable state.");
    t.diagnostic("natural end brief: " + JSON.stringify({
      topic: ended.topic,
      moderatorId: ended.moderatorId,
      panelists: ended.panelists.map(function (panelist) { return panelist.mateId; }),
    }));
  } finally {
    h.cleanup();
  }
});

test("restart validates deleted Mate ids before it creates a fresh debate", function () {
  var h = makeHarness();
  try {
    h.source._debate = makeDebateState(h.mateCtx);
    h.source._debate.phase = "ended";
    restartFromEndedBrief(h, {
      topic: "Should Clay retain debate briefs?",
      format: "round_robin",
      context: "",
      specialRequests: null,
      moderatorId: "mate_cccc",
      panelists: [{ mateId: "mate_deleted", role: "Missing", brief: "No longer exists." }],
    });

    assert.strictEqual(h.created.length, 0);
    assert.match(latestMessage(h, "debate_error").error, /None of the panelists match existing Mates/);
  } finally {
    h.cleanup();
  }
});

test("ended-state UI offers a restart carrying every persisted brief field", function () {
  var ui = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-debate-ui.js"), "utf8");
  assert.match(ui, /Debate ended — restart with the same brief\?/);
  assert.match(ui, /Restart with same brief/);
  assert.match(ui, /restartBrief: true/);
  assert.match(ui, /context: msg\.context/);
  assert.match(ui, /specialRequests: msg\.specialRequests/);
  assert.match(ui, /panelists: msg\.panelists/);
});
