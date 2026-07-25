var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("orchestration close confirmation presents two distinct choices", function () {
  var source = fs.readFileSync(path.join(__dirname, "../lib/public/modules/queued-messages.js"), "utf8");
  var closeTaskStart = source.indexOf("function closeTask(task)");
  var closeTaskEnd = source.indexOf("\n}\n\nexport function", closeTaskStart);
  var closeTaskSource = source.slice(closeTaskStart, closeTaskEnd);

  assert.match(closeTaskSource, /"Close task",\s*true,\s*null,\s*null,\s*"Keep task"/);
});
