var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

// Regression for the 2026-07-31 daemon crash: a propose_debate approved from
// a project session (not a Mate DM) carried moderatorId=null into
// startDebateLive, where getMateDir(path.join(root, null)) threw an uncaught
// TypeError and took down the whole daemon. These tests cover the id
// resolution / fallback-moderator helpers and the null guards added to the
// mate file loaders.

function clearModuleCache() {
  ["../lib/config", "../lib/mates", "../lib/project-debate-utils"].forEach(function (m) {
    try { delete require.cache[require.resolve(m)]; } catch (e) {}
  });
}

function makeHarness(mates) {
  var tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-debate-approval-"));
  var oldClayHome = process.env.CLAY_HOME;
  process.env.CLAY_HOME = tmpHome;
  clearModuleCache();

  var matesDir = path.join(tmpHome, "mates");
  fs.mkdirSync(matesDir, { recursive: true });
  fs.writeFileSync(path.join(matesDir, "mates.json"), JSON.stringify({ mates: mates }));

  var debateUtils = require("../lib/project-debate-utils");
  var mateCtx = { userId: null, multiUser: false, linuxUser: null };

  return {
    debateUtils: debateUtils,
    mateCtx: mateCtx,
    cleanup: function () {
      if (typeof oldClayHome === "string") process.env.CLAY_HOME = oldClayHome;
      else delete process.env.CLAY_HOME;
      clearModuleCache();
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (e) {}
    },
  };
}

var UUID_A = "aaaaaaaa-0000-0000-0000-000000000001";
var UUID_B = "bbbbbbbb-0000-0000-0000-000000000002";
var TEAM = [
  { id: "mate_" + UUID_A, name: "Arch", status: "ready" },
  { id: "mate_" + UUID_B, name: "Ward", status: "ready" },
  { id: "mate_cccc", name: "Clay", status: "ready", builtinKey: "clay" },
  { id: "mate_dddd", name: "Newbie", status: "interviewing" },
];

test("resolveMateId accepts exact ids and unprefixed UUIDs, rejects unknown/null", function () {
  var h = makeHarness(TEAM);
  try {
    var u = h.debateUtils;
    assert.strictEqual(u.resolveMateId(h.mateCtx, "mate_" + UUID_A), "mate_" + UUID_A);
    // MCP tools pass raw UUIDs (the propose_debate schema only promises "<UUID>")
    assert.strictEqual(u.resolveMateId(h.mateCtx, UUID_A), "mate_" + UUID_A);
    assert.strictEqual(u.resolveMateId(h.mateCtx, "no-such-mate"), null);
    assert.strictEqual(u.resolveMateId(h.mateCtx, null), null);
    assert.strictEqual(u.resolveMateId(h.mateCtx, undefined), null);
    assert.strictEqual(u.resolveMateId(h.mateCtx, 42), null);
  } finally {
    h.cleanup();
  }
});

test("pickFallbackModerator prefers the clay builtin and skips panelists", function () {
  var h = makeHarness(TEAM);
  try {
    var u = h.debateUtils;
    // clay builtin wins even when listed later
    assert.strictEqual(u.pickFallbackModerator(h.mateCtx, []), "mate_cccc");
    // panelists are excluded; falls to first remaining ready mate
    assert.strictEqual(
      u.pickFallbackModerator(h.mateCtx, ["mate_cccc", "mate_" + UUID_A]),
      "mate_" + UUID_B
    );
  } finally {
    h.cleanup();
  }
});

test("pickFallbackModerator skips interviewing mates and returns null when no one is available", function () {
  var h = makeHarness(TEAM);
  try {
    var u = h.debateUtils;
    var everyone = ["mate_" + UUID_A, "mate_" + UUID_B, "mate_cccc"];
    // Only the interviewing mate remains -> no moderator
    assert.strictEqual(u.pickFallbackModerator(h.mateCtx, everyone), null);
  } finally {
    h.cleanup();
  }
});

test("pickFallbackModerator returns null with an empty team", function () {
  var h = makeHarness([]);
  try {
    assert.strictEqual(h.debateUtils.pickFallbackModerator(h.mateCtx, []), null);
  } finally {
    h.cleanup();
  }
});

test("getMateDir still throws on null id — callers must guard (documents the crash mechanism)", function () {
  var h = makeHarness(TEAM);
  try {
    var matesModule = require("../lib/mates");
    assert.throws(function () { matesModule.getMateDir(h.mateCtx, null); }, TypeError);
  } finally {
    h.cleanup();
  }
});

// --- Debate worker sessions must not leak into the CLI import list ----------

test("isDebateWorkerPrompt recognizes moderator/panelist prompts and nothing else", function () {
  var u = require("../lib/project-debate-utils");
  assert.strictEqual(u.isDebateWorkerPrompt(u.DEBATE_MODERATOR_PROMPT_PREFIX + "\n\nTopic: X"), true);
  assert.strictEqual(u.isDebateWorkerPrompt(u.DEBATE_PANELIST_PROMPT_PREFIX + "\n\nTopic: X"), true);
  // Injected instructions above the prompt must not defeat detection
  assert.strictEqual(u.isDebateWorkerPrompt("--- Instructions ---\nrules\n\n" + u.DEBATE_PANELIST_PROMPT_PREFIX), true);
  // Ordinary sessions stay visible
  assert.strictEqual(u.isDebateWorkerPrompt("I have a script on desktop that i run"), false);
  assert.strictEqual(u.isDebateWorkerPrompt("Let's discuss a structured debate feature"), false);
  assert.strictEqual(u.isDebateWorkerPrompt(""), false);
  assert.strictEqual(u.isDebateWorkerPrompt(null), false);
});

// --- F-6: approval must report the real outcome ------------------------------
// The MCP proposal used to resolve {action:"start"} unconditionally: a null
// ws-session or any handler bail silently no-oped while the proposing model
// was told "Debate approved and started". The mcp-server must map the new
// {action:"error"} outcome to an honest tool result.

test("debate-mcp-server reports error outcomes instead of false success", async function () {
  var debateMcp = require("../lib/debate-mcp-server");
  var outcomes = [
    { resolve: { action: "start" }, expect: /approved and started/i },
    { resolve: { action: "error", reason: "the approving client has no active session" }, expect: /could NOT start: the approving client has no active session/i },
    { resolve: { action: "error" }, expect: /could NOT start: unknown reason/i },
    { resolve: { action: "cancel" }, expect: /cancelled/i },
  ];
  for (var i = 0; i < outcomes.length; i++) {
    var o = outcomes[i];
    var tools = debateMcp.getToolDefs(function () { return Promise.resolve(o.resolve); });
    var res = await tools[0].handler({ topic: "T", panelists: "[]" });
    var text = res.content[0].text;
    assert.ok(o.expect.test(text), "outcome " + JSON.stringify(o.resolve) + " produced: " + text);
    if (o.resolve.action !== "start") {
      assert.ok(!/approved and started/i.test(text),
        "non-start outcome must never read as success: " + text);
    }
  }
});
