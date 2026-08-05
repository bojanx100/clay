var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("orchestration close confirmation presents two distinct choices", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/orchestration-task-preview.js"),
    "utf8"
  );
  var html = fs.readFileSync(path.join(__dirname, "../lib/public/index.html"), "utf8");
  var modalSource = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-misc.js"), "utf8");
  var closeTaskStart = source.indexOf("function closeTask(task)");
  var closeTaskEnd = source.indexOf("\n}\n\nexport function", closeTaskStart);
  var closeTaskSource = source.slice(closeTaskStart, closeTaskEnd);

  assert.match(closeTaskSource, /"Close task",\s*true,\s*"Keep task"/);
  assert.doesNotMatch(html, /confirm-secondary/);
  assert.doesNotMatch(modalSource, /confirmSecondary|secondaryLabel|onSecondary/);
});

test("coordinator close confirmation warns about every worker that is not complete", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/app-messages-sessions.js"),
    "utf8"
  );
  var sidebarSource = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/sidebar-sessions-delete.js"),
    "utf8"
  );
  var handlerStart = source.indexOf("function handleCoordinatorCloseRequired(msg)");
  var handlerEnd = source.indexOf("\n}\n\nfunction handleSessionList", handlerStart);
  var closeCoordinatorSource = source.slice(handlerStart, handlerEnd);

  assert.match(closeCoordinatorSource, /msg\.atRiskWorkerCount \|\| msg\.activeWorkerCount/);
  assert.match(closeCoordinatorSource, /still running or need attention/);
  assert.match(closeCoordinatorSource, /every worker conversation/);
  assert.match(sidebarSource, /archive every worker conversation/);
});
