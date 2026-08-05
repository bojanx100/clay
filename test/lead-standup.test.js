// Tests for the Lead standup composer (CTO orchestrator brick 5).
var test = require("node:test");
var assert = require("node:assert");

var standup = require("../lib/lead-standup");

var NOW = 1785800000000;
var H = 3600000;

function item(id, title) { return { id: id, title: title, project: "clay" }; }
var ROUTE = { vendor: "codex", model: "gpt-5.6-luna", tier: 2 };

test("standup sections reflect typed events only", function () {
  var out = standup.composeStandup({
    now: NOW,
    events: [
      { type: "staffed", at: NOW - 5 * H, item: item("clay#1", "Restart-with-brief card"), route: ROUTE },
      { type: "completed", at: NOW - 2 * H, item: item("clay#1", "Restart-with-brief card"), route: ROUTE, verificationDepth: "standard", evidence: "suite 493/493; card verified via replayed WS" },
      { type: "staffed", at: NOW - 3 * H, item: item("clay#2", "Hand-raise exercise"), route: ROUTE },
      { type: "staffed", at: NOW - 1 * H, item: item("tv#9", "Fix upload crash"), route: { vendor: "claude", model: "opus", tier: 3 } },
      { type: "blocked", at: NOW, item: item("tv#9", "Fix upload crash"), route: ROUTE, reason: "needs prod credentials decision" },
    ],
    canaries: { recoveryEvents: 0, wsHandlerErrors: 0 },
  });
  assert.strictEqual(out.counts.shipped, 1);
  assert.strictEqual(out.counts.inFlight, 1); // clay#2 only; tv#9 went terminal
  assert.strictEqual(out.counts.needsYou, 1);
  assert.ok(/Shipped \(1\)/.test(out.text));
  assert.ok(/evidence: suite 493\/493/.test(out.text));
  assert.ok(/running 3h/.test(out.text));
  assert.ok(/BLOCKED: clay tv#9/.test(out.text) || /BLOCKED: .*tv#9/.test(out.text));
  assert.ok(/canaries quiet/.test(out.text));
});

test("completion without evidence is flagged, never trusted", function () {
  var out = standup.composeStandup({
    now: NOW,
    events: [
      { type: "completed", at: NOW, item: item("clay#3", "Thing"), route: ROUTE, verificationDepth: "light" },
    ],
  });
  assert.ok(/evidence: MISSING \(do not trust\)/.test(out.text));
});

test("failed items report retry state", function () {
  var out = standup.composeStandup({
    now: NOW,
    events: [
      { type: "failed", at: NOW, item: item("clay#4", "Flaky fix"), route: ROUTE, reason: "suite regressed", willRetryAtTier: 3 },
      { type: "failed", at: NOW, item: item("clay#5", "Doomed"), route: ROUTE, reason: "still failing" },
    ],
  });
  assert.ok(/auto-retrying at tier 3/.test(out.text));
  assert.ok(/out of retries/.test(out.text));
});

test("up-next previews the portfolio and warns on unroutable", function () {
  var out = standup.composeStandup({
    now: NOW,
    events: [],
    portfolio: {
      items: [
        { id: "tv#12", title: "Crash", project: "trialview", score: 630, route: { vendor: "claude", model: "opus" } },
        { id: "tv#15", title: "Typo", project: "trialview", score: 55, route: null },
      ],
      summary: { total: 2, unroutable: 1 },
    },
  });
  assert.ok(/\[630\]/.test(out.text));
  assert.ok(/UNROUTABLE/.test(out.text));
  assert.ok(/WARNING: 1 item\(s\) unroutable/.test(out.text));
});

test("missing canary data is stated, not assumed quiet", function () {
  var out = standup.composeStandup({ now: NOW, events: [] });
  assert.ok(/canary data unavailable/.test(out.text));
});

test("noisy canaries poison trust explicitly", function () {
  var out = standup.composeStandup({
    now: NOW, events: [],
    canaries: { recoveryEvents: 3, wsHandlerErrors: 1 },
  });
  assert.ok(/NOT quiet/.test(out.text));
  assert.ok(/investigate before trusting green gates/.test(out.text));
});

test("Health renders typed daily vendor burn rate and pressure", function () {
  var out = standup.composeStandup({
    now: NOW,
    events: [],
    canaries: { recoveryEvents: 0, wsHandlerErrors: 0 },
    budget: {
      type: "daily_vendor_usage",
      dataAvailable: true,
      byVendor: {
        claude: {
          turns: 2, spendUsd: 4.5, spendAvailable: true, spendComplete: true,
          totalTokens: 12000, usageAvailable: true, usageComplete: true,
        },
        codex: {
          turns: 1, spendUsd: 0, spendAvailable: false, spendComplete: false,
          totalTokens: 3000, usageAvailable: true, usageComplete: true,
        },
      },
      pressure: { active: true, known: true, ratio: 0.84 },
    },
  });
  assert.ok(/## Health/.test(out.text));
  assert.ok(/burn rate today: claude \$4\.50, 12,000 tokens \(2 turns\)/.test(out.text));
  assert.ok(/codex spend unavailable, 3,000 tokens \(1 turn\)/.test(out.text));
  assert.ok(/budget pressure 84%/.test(out.text));
});

test("Health states when burn-rate data is unavailable", function () {
  var out = standup.composeStandup({ now: NOW, events: [] });
  assert.ok(/burn rate unavailable/.test(out.text));
});

test("standup reports separate worker, project, and Coop portfolio completion levels", function () {
  var out = standup.composeStandup({
    now: NOW,
    events: [
      { type: "worker_completed", portfolioTaskId: "leaf", bindingRevision: 1 },
      { type: "project_completed", portfolioTaskId: "project", bindingRevision: 2 },
      { type: "project_completion_revoked", portfolioTaskId: "project", completionRevision: 3,
        reason: "task_retry_requested" },
      { type: "portfolio_completed", portfolioTaskId: "portfolio-root", owner: "coop" },
    ],
  });

  assert.ok(/WORKER EVIDENCE: leaf rev 1 \(does not close project or portfolio\)/.test(out.text));
  assert.ok(/PROJECT VERIFIED: project rev 2/.test(out.text));
  assert.ok(/PROJECT REVOKED: project rev 3 — task_retry_requested/.test(out.text));
  assert.ok(/PORTFOLIO CLOSED BY COOP: portfolio-root/.test(out.text));
});
