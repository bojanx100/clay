// Regression tests for vendor-handoff context injection and consumption.
//
// Observed defects: (1) the live send path kept re-injecting the full handoff
// transcript for the whole 4-turn budget even after the new vendor responded
// successfully (token waste + "just handed off" re-framing — the exact bug
// sessions-loader already fixed for the restart path); (2) synthetic sends
// (scheduled messages) bypassed injection entirely, reaching the new vendor
// with zero context.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync } = require("child_process");

var handoff = require("../lib/handoff-context");
var handoffState = require("../lib/handoff-state");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-handoff-state-"));
}

function initGitRepo(dir, branch) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: dir });
}

function switchedSession(vendor, context) {
  return {
    vendor: vendor,
    handoffContext: context || "<clay_handoff_context>prior work</clay_handoff_context>",
    handoffContextTurnsRemaining: handoff.handoffTurnBudgetForVendor(vendor),
  };
}

test("applyHandoffToOutgoingText wraps the message and burns one turn", function () {
  var s = switchedSession("codex");
  var out = handoff.applyHandoffToOutgoingText(s, "fix the login bug");
  assert.ok(out.indexOf("<clay_handoff_context>") === 0, "context prepended");
  assert.ok(out.indexOf("<current_user_message>\nfix the login bug\n</current_user_message>") !== -1);
  assert.strictEqual(s.handoffContextTurnsRemaining, 3);
  assert.ok(s.handoffContext, "context retained while budget remains");
  assert.ok(!s.handoffContextConsumed);
});

test("budget exhaustion consumes the handoff terminally", function () {
  var s = switchedSession("codex");
  for (var i = 0; i < 4; i++) handoff.applyHandoffToOutgoingText(s, "msg " + i);
  assert.strictEqual(s.handoffContext, null);
  assert.strictEqual(s.handoffContextConsumed, true);
  // Further sends pass through untouched.
  assert.strictEqual(handoff.applyHandoffToOutgoingText(s, "plain"), "plain");
});

test("github-copilot gets exactly one handoff turn and arms the native reset", function () {
  var s = switchedSession("github-copilot");
  s.handoffContextTurnsRemaining = 4; // stale/over-provisioned value must clamp
  handoff.applyHandoffToOutgoingText(s, "hello");
  assert.strictEqual(s.handoffContext, null);
  assert.strictEqual(s.handoffContextConsumed, true);
  assert.strictEqual(s.copilotResetAfterCurrentHandoffTurn, true);
});

test("a successful turn finalizes the handoff early (budget is retry headroom)", function () {
  var s = switchedSession("codex");
  handoff.applyHandoffToOutgoingText(s, "first message"); // turns 4 -> 3
  // New vendor responded with real output -> native session carries context.
  assert.strictEqual(handoff.finalizeHandoffAfterSuccessfulTurn(s), true);
  assert.strictEqual(s.handoffContext, null);
  assert.strictEqual(s.handoffContextTurnsRemaining, 0);
  assert.strictEqual(s.handoffContextConsumed, true);
  // No pending handoff -> finalize is a no-op returning false.
  assert.strictEqual(handoff.finalizeHandoffAfterSuccessfulTurn(s), false);
});

test("no pending handoff leaves outgoing text untouched", function () {
  var s = { vendor: "codex" };
  assert.strictEqual(handoff.applyHandoffToOutgoingText(s, "hello"), "hello");
  assert.strictEqual(handoff.applyHandoffToOutgoingText(null, "hello"), "hello");
});

test("first-response framing: header and trailer forbid handoff narration", function () {
  var history = [
    { type: "user_message", text: "fix the bug", _ts: 1700000000000 },
    { type: "delta", text: "on it", _ts: 1700000000001 },
  ];
  var brief = handoff.buildHandoffContextFromHistory(history, {
    fromVendor: "claude", toVendor: "codex",
  });
  assert.ok(brief.indexOf("joining an ongoing conversation mid-stream") !== -1, "mid-stream framing in header");
  assert.ok(brief.indexOf("do not introduce yourself") !== -1, "no self-introduction instruction");
  assert.ok(brief.indexOf("I can see you were working on") !== -1, "anti-narration example present");

  var s = switchedSession("codex", brief);
  var out = handoff.applyHandoffToOutgoingText(s, "and the tests?");
  assert.ok(out.indexOf("no self-introduction, no handoff acknowledgement") !== -1, "trailer reinforces framing");
});

test("collectWorkingAgreements mines standing instructions, skips goal/questions/synthetic", function () {
  var history = [
    { type: "user_message", text: "Never use tabs in this repo, always spaces", _ts: 1 }, // goal — skipped
    { type: "delta", text: "ok", _ts: 2 },
    { type: "user_message", text: "don't add comments everywhere, keep them minimal", _ts: 3 },
    { type: "user_message", text: "should we always run the linter?", _ts: 4 }, // question — skipped
    { type: "user_message", text: "[Auto-continued] never mind this marker", _ts: 5 }, // synthetic — skipped
    { type: "user_message", text: "use zod instead of manual validation. Looks good so far.", _ts: 6 },
    { type: "user_message", text: "don't add comments everywhere, keep them minimal", _ts: 7 }, // dupe
  ];
  var agreements = handoffState.collectWorkingAgreements(history);
  assert.deepStrictEqual(agreements, [
    "don't add comments everywhere, keep them minimal",
    "use zod instead of manual validation.",
  ]);
  assert.strictEqual(handoffState.collectWorkingAgreements([
    { type: "user_message", text: "do the thing", _ts: 1 },
    { type: "user_message", text: "thanks, looks great", _ts: 2 },
  ]), null, "no instruction-like sentences -> null");
});

test("brief renders working agreements section from history", function () {
  var history = [
    { type: "user_message", text: "build the exporter", _ts: 1 },
    { type: "user_message", text: "always write CSV with semicolons, not commas", _ts: 2 },
  ];
  var brief = handoff.buildHandoffContextFromHistory(history, {
    fromVendor: "claude", toVendor: "codex",
  });
  assert.ok(brief.indexOf("Working agreements") !== -1, "agreements section present");
  assert.ok(brief.indexOf("always write CSV with semicolons, not commas") !== -1, "agreement listed");
  assert.ok(brief.indexOf("Working agreements") < brief.indexOf("<prior_transcript>"), "sits in header");
});

test("brief enriches the header with goal, git state, tasks, and doc paths", function () {
  var cwd = tmpDir();
  try {
    initGitRepo(cwd, "feature-x");
    fs.writeFileSync(path.join(cwd, "dirty.js"), "var x = 1;\n");
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs", "FEATURE-PLAN.md"), "# plan\n");

    var history = [
      { type: "user_message", text: "Build a login form with validation", _ts: 1700000000000 },
      { type: "delta", text: "working on it", _ts: 1700000000001 },
      {
        type: "tool_executing",
        name: "TodoWrite",
        id: "t1",
        input: {
          todos: [
            { id: "1", content: "Design schema", status: "completed" },
            { id: "2", content: "Write handler", status: "in_progress" },
            { id: "3", content: "Add tests", status: "pending" },
          ],
        },
        _ts: 1700000000002,
      },
    ];

    var brief = handoff.buildHandoffContextFromHistory(history, {
      fromVendor: "claude", toVendor: "codex", cwd: cwd,
    });
    assert.ok(brief, "brief generated");
    assert.ok(brief.indexOf("Original user goal: Build a login form with validation") !== -1, "goal line present");
    assert.ok(brief.indexOf("Git branch: feature-x") !== -1, "branch present");
    assert.ok(brief.indexOf("dirty.js") !== -1, "dirty file listed");
    assert.ok(brief.indexOf("[x] Design schema") !== -1, "completed task checkmark");
    assert.ok(brief.indexOf("[~] Write handler") !== -1, "in-progress task marker");
    assert.ok(brief.indexOf("[ ] Add tests") !== -1, "pending task marker");
    assert.ok(brief.indexOf(path.join("docs", "FEATURE-PLAN.md")) !== -1, "plan doc path listed");
    // The enriched sections sit ABOVE the transcript body, still inside the guard.
    assert.ok(brief.indexOf("Git branch: feature-x") < brief.indexOf("<prior_transcript>"), "state precedes transcript");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("brief degrades cleanly: non-git dir, no todos, no docs -> sections omitted", function () {
  var cwd = tmpDir();
  try {
    var history = [
      { type: "user_message", text: "just a chat", _ts: 1700000000000 },
      { type: "delta", text: "sure", _ts: 1700000000001 },
    ];
    var brief;
    assert.doesNotThrow(function () {
      brief = handoff.buildHandoffContextFromHistory(history, {
        fromVendor: "claude", toVendor: "codex", cwd: cwd,
      });
    }, "no throw in a non-git dir");
    assert.ok(brief, "brief still generated");
    assert.strictEqual(brief.indexOf("Git branch:"), -1, "no git section");
    assert.strictEqual(brief.indexOf("Current tasks:"), -1, "no tasks section");
    assert.strictEqual(brief.indexOf("Plan/handoff docs:"), -1, "no docs section");
    // The original goal comes from history alone, so it is still present.
    assert.ok(brief.indexOf("Original user goal: just a chat") !== -1, "goal still present from history");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
