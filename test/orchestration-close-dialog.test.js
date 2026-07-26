var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("orchestration close confirmation presents two distinct choices", function () {
  var source = fs.readFileSync(path.join(__dirname, "../lib/public/modules/queued-messages.js"), "utf8");
  var html = fs.readFileSync(path.join(__dirname, "../lib/public/index.html"), "utf8");
  var modalSource = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-misc.js"), "utf8");
  var closeTaskStart = source.indexOf("function closeTask(task)");
  var closeTaskEnd = source.indexOf("\n}\n\nexport function", closeTaskStart);
  var closeTaskSource = source.slice(closeTaskStart, closeTaskEnd);

  assert.match(closeTaskSource, /"Close task",\s*true,\s*"Keep task"/);
  assert.doesNotMatch(html, /confirm-secondary/);
  assert.doesNotMatch(modalSource, /confirmSecondary|secondaryLabel|onSecondary/);
});
