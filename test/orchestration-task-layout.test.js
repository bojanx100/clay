var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

test("worker preview defaults to one compact expandable row", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/orchestration-task-preview.js"),
    "utf8"
  );
  var css = fs.readFileSync(
    path.join(__dirname, "../lib/public/css/input.css"),
    "utf8"
  );
  var sidebarSource = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/sidebar-sessions.js"),
    "utf8"
  );
  var sidebarCss = fs.readFileSync(
    path.join(__dirname, "../lib/public/css/sidebar.css"),
    "utf8"
  );
  var orchestratorSource = fs.readFileSync(
    path.join(__dirname, "../lib/project-task-orchestrator.js"),
    "utf8"
  );
  var runtimeSource = fs.readFileSync(
    path.join(__dirname, "../lib/project-runtime.js"),
    "utf8"
  );

  assert.match(source, /var MAX_PREVIEW_WORKERS = 3/);
  assert.match(source, /summary\.setAttribute\("aria-expanded", isExpanded \? "true" : "false"\)/);
  assert.match(source, /store\.set\(\{ orchestrationTaskPreviewExpanded: !isExpanded \}\)/);
  assert.match(source, /if \(!store\.get\("orchestrationTaskPreviewExpanded"\)\) \{/);
  assert.match(source, /state\.phase === "complete"/);
  assert.match(source, /Reconciliation stalled/);
  assert.match(source, /retry_orchestration_reconciliation/);
  assert.match(css, /\.orchestration-task-summary\s*\{[^}]*min-height:\s*42px[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(240px,\s*30dvh\)[^}]*overflow-y:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(168px,\s*22dvh\)/);
  assert.match(sidebarSource, /worker-status-" \+ orchestrationParent\.taskStatus/);
  assert.match(sidebarCss, /\.session-vendor-dot\.worker-status-completed\s*\{[^}]*background:\s*var\(--success\)/s);
  assert.match(sidebarCss, /\.session-item\.worker-status-completed\s*\{[^}]*--worker-state-color:\s*var\(--success\)/s);
  assert.match(sidebarCss, /box-shadow:[^;]*var\(--worker-state-color,\s*var\(--worker-color/s);
  assert.match(orchestratorSource, /if \(statusChanged\) sm\.broadcastSessionList\(\)/);
  assert.match(runtimeSource, /taskOrchestrator\.handleCoordinatorTurnDone\(session\)/);
  assert.match(css, /\.orchestration-task-status-waiting_user/);
  assert.match(css, /\.orchestration-task-status-dismissed/);
});

test("chat worker preview keeps unfinished work and hides resolved-only groups", async function () {
  var modulePath = path.join(
    __dirname, "../lib/public/modules/orchestration-task-preview.js"
  );
  var preview = await import(pathToFileURL(modulePath).href);
  var activeTasks = preview.activeWorkerPreviewTasks([
    { taskId: "queued", status: "queued" },
    { taskId: "running", status: "running" },
    { taskId: "attention", status: "needs_input" },
    { taskId: "completed", status: "completed" },
    { taskId: "dismissed", status: "dismissed" },
    { taskId: "cancelled", status: "cancelled" },
  ]);

  assert.deepEqual(activeTasks.map(function (task) { return task.taskId; }), [
    "queued", "running", "attention",
  ]);

  var host = { innerHTML: "stale preview" };
  var rendered = preview.renderOrchestrationTaskPreview(host, [
    { taskId: "completed", status: "completed" },
    { taskId: "dismissed", status: "dismissed" },
  ], { phase: "complete" });

  assert.equal(rendered, null);
  assert.equal(host.innerHTML, "");
});
