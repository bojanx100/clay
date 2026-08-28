var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var attachTaskLauncher = require("../lib/project-task-launcher").attachTaskLauncher;
var ownerAcceptance = require("../lib/project-owner-acceptance");
var setupTemplates = require("../lib/project-task-setup-templates");
var createBindings = require("../lib/portfolio-execution-bindings")
  .createPortfolioExecutionBindings;
var attachSessionLedger = require("../lib/coop-session-ledger").attachCoopSessionLedger;

function launcherHarness() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-acceptance-launcher-"));
  var sessions = new Map();
  var starts = [];
  var nextId = 1;
  var sm = {
    sessions: sessions,
    defaultVendor: "claude",
    serverDefaultMode: "default",
    createSessionRaw: function (options) {
      var session = Object.assign({ localId: nextId++, history: [] }, options || {});
      sessions.set(session.localId, session);
      return session;
    },
    appendToSessionFile: function () {},
    saveSessionFile: function () {},
    broadcastSessionList: function () {},
    hideSession: function (id) { sessions.get(id).hidden = true; },
  };
  var launcher = attachTaskLauncher({
    cwd: cwd,
    sm: sm,
    sdk: { startQuery: function (session, prompt) {
      starts.push({ session: session, prompt: prompt });
    } },
    sendTo: function () {},
    usersModule: { isMultiUser: function () { return false; } },
    ensureProjectAccessForSession: function () {},
    onProcessingChanged: function () {},
  });
  return { cwd: cwd, launcher: launcher, sessions: sessions, starts: starts };
}

function issue() {
  return { number: 2200, title: "Hover loop", body: "Fix it", url: "issue-2200" };
}

test("generated Webapp recipes require both local authorities before triage", function () {
  var recipe = setupTemplates.buildAutoRecipe({
    recipeId: "bugs", repo: "owner/repo", assigned: "any",
  });
  assert.deepEqual(recipe.prompt.includeFiles, [
    "localAIConfig/AGENTS.local.md",
    "localAIConfig/TRIAGE.local.md",
  ]);
  assert.deepEqual(recipe.prompt.requiredIncludeFiles, recipe.prompt.includeFiles);
  assert.equal(recipe.completion.requireUserTrigger, true);
  assert.equal(setupTemplates.buildManualRecipe({
    recipeId: "bugs", repo: "owner/repo", assigned: "any",
  }).completion.requireUserTrigger, true);
});

test("required project-local instructions fail before session creation or provider start", function () {
  var harness = launcherHarness();
  var recipe = setupTemplates.buildAutoRecipe({
    recipeId: "bugs", repo: "owner/repo", assigned: "any",
  });
  assert.throws(function () {
    harness.launcher.startSessionForItem(null, recipe, issue(), {}, null, {});
  }, /Required project instruction is missing or empty/);
  assert.equal(harness.sessions.size, 0);
  assert.equal(harness.starts.length, 0);
});

test("an existing Webapp launcher loads both local authorities in order", function () {
  var harness = launcherHarness();
  fs.mkdirSync(path.join(harness.cwd, "localAIConfig"), { recursive: true });
  fs.writeFileSync(path.join(harness.cwd, "localAIConfig", "AGENTS.local.md"),
    "AGENTS LOCAL FIRST\nRead triage before staffing.\n");
  fs.writeFileSync(path.join(harness.cwd, "localAIConfig", "TRIAGE.local.md"),
    "TRIAGE LOCAL SECOND\nNever mark Done without explicit owner acceptance.\n");
  var recipe = {
    id: "legacy-webapp",
    source: { provider: "github", kind: "issues", repo: "owner/repo" },
    prompt: { includeFiles: ["localAIConfig/TRIAGE.local.md"] },
    session: { vendor: "claude" },
    completion: { marker: "WORKFLOW_COMPLETE: issue_shipped", closeSession: true },
  };
  var session = harness.launcher.startSessionForItem(null, recipe, issue(), {}, null, {});
  var prompt = harness.starts[0].prompt;
  assert.ok(prompt.indexOf("AGENTS LOCAL FIRST") < prompt.indexOf("TRIAGE LOCAL SECOND"));
  assert.equal(prompt.match(/TRIAGE LOCAL SECOND/g).length, 1);
  assert.equal(session.taskLauncher.completion.requireUserTrigger, true);
});

test("a completion marker cannot replace the owner's explicit Done phrase", function () {
  var harness = launcherHarness();
  var session = {
    localId: 1,
    history: [],
    isProcessing: false,
    taskLauncher: {
      completion: {
        marker: "WORKFLOW_COMPLETE: issue_shipped",
        closeSession: true,
        requireUserTrigger: true,
      },
    },
  };
  harness.sessions.set(session.localId, session);
  harness.launcher.handleTaskTurnDone(session, "", "WORKFLOW_COMPLETE: issue_shipped");
  assert.notEqual(session.taskLauncher.workflowCompleted, true);
  assert.equal(harness.launcher.handleTaskUserMessageDispatched(
    session, "looks good", null), "");
  assert.notEqual(session.taskLauncher.workflowCompleted, true);
  var directive = harness.launcher.handleTaskUserMessageDispatched(session, "done", null);
  assert.match(directive, /user asked to mark this task as done/i);
  assert.equal(session.taskLauncher.ownerCompletionApproval.status, "accepted");
  harness.launcher.handleTaskTurnDone(session, "", "WORKFLOW_COMPLETE: issue_shipped");
  assert.equal(session.taskLauncher.workflowCompleted, true);
});

test("owner trigger matching is narrow and never accepts replay-adjacent prose", function () {
  assert.equal(ownerAcceptance.matchesCompletionTrigger({}, "done"), true);
  assert.equal(ownerAcceptance.matchesCompletionTrigger({}, "please ship it"), true);
  assert.equal(ownerAcceptance.matchesCompletionTrigger({}, "the worker said done yesterday"), false);
  assert.equal(ownerAcceptance.matchesCompletionTrigger({}, "looks good"), false);
});

test("the exact runtime repair preserves technical completion and appends pending acceptance", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-acceptance-repair-"));
  var bindingFile = path.join(dir, "bindings.json");
  var projectId = "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04";
  var sessionId = "webapp-2200-session";
  var store = createBindings({ file: bindingFile, now: function () { return 20; },
    reconcileOnLoad: false });
  assert.equal(store.reserve({
    portfolioTaskId: "portfolio-webapp-2200",
    bindingRevision: 2,
    idempotencyKey: "webapp-2200-r2",
    mode: "project_coordinator",
    targetProject: { projectId: projectId },
    source: { projectId: "system-lead", sessionStorageId: "coop-owner" },
  }).ok, true);
  assert.equal(store.commit("portfolio-webapp-2200", 2, {
    projectId: projectId, sessionStorageId: sessionId,
  }).ok, true);
  assert.equal(store.complete("portfolio-webapp-2200", 2, {
    eventId: "project-terminal-r2",
    resultEventId: "project-result-r2",
    terminalStatus: "completed",
  }).ok, true);
  var repaired = store.requireOwnerAcceptance("portfolio-webapp-2200", 2, {
    completionEventId: "project-terminal-r2",
    resultEventId: "project-result-r2",
    correctionEventId: "owner-acceptance-repair-2200-r2",
    repairedAt: 30,
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.binding.status, "completed");
  assert.equal(repaired.binding.ownerAcceptanceRequired, true);
  assert.equal(repaired.binding.ownerAcceptance.status, "pending");
  assert.equal(repaired.binding.completionEventId, "project-terminal-r2");
  assert.equal(repaired.binding.resultEventId, "project-result-r2");

  var reloaded = createBindings({ file: bindingFile, reconcileOnLoad: false });
  var durable = reloaded.get("portfolio-webapp-2200", 2);
  assert.equal(durable.status, "completed");
  assert.equal(durable.ownerAcceptanceRepair.correctionEventId,
    "owner-acceptance-repair-2200-r2");

  var ledgerFile = path.join(dir, "coop-session-ledger.json");
  var ledger = attachSessionLedger({ file: ledgerFile, now: function () { return 40; } });
  var session = {
    storageId: sessionId,
    title: "Webapp #2200",
    coopControlledBy: { coopSessionStorageId: "coop-owner", since: 1 },
    orchestrationPolicy: { portfolioExecution: {
      portfolioTaskId: "portfolio-webapp-2200",
      bindingRevision: 2,
      mode: "project_coordinator",
      status: "completed",
      completedAt: 20,
    } },
    orchestrationProjectCompletion: { status: "completed", completedAt: 20,
      summary: "Implementation verified" },
  };
  assert.equal(ledger.reconcile({
    bindings: [Object.assign({}, durable, {
      ownerAcceptanceRequired: undefined, ownerAcceptance: undefined,
    })],
    projects: [{ projectRef: { projectId: projectId }, sessions: [session] }],
  }).ok, true);
  assert.equal(ledger.get({ projectId: projectId, sessionStorageId: sessionId }).workState,
    "done");
  var ledgerRepair = ledger.requireOwnerAcceptance({
    projectId: projectId, sessionStorageId: sessionId,
  }, {
    portfolioTaskId: "portfolio-webapp-2200", bindingRevision: 2,
  }, {
    correctionEventId: "owner-acceptance-repair-2200-r2", repairedAt: 30,
  });
  assert.equal(ledgerRepair.ok, true);
  assert.equal(ledgerRepair.entry.lifecycleState, "needs_input");
  assert.equal(ledgerRepair.entry.workState, "needs_input");
  assert.equal(ledgerRepair.entry.closedAt, null);
  assert.equal(ledgerRepair.entry.terminalOutcome, null);
  assert.equal(ledgerRepair.entry.ownerAcceptanceRepair.previousProjection.workState, "done");
});
