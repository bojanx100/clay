var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("stale needs-input cards expose a verified coordinator resolution action", function () {
  var queuedSource = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/queued-messages.js"),
    "utf8"
  );
  var dialogSource = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/orchestration-task-resolution-dialog.js"),
    "utf8"
  );

  assert.match(queuedSource, /task\.status === "needs_input" \|\| task\.status === "failed"/);
  assert.match(queuedSource, /type: "resolve_orchestration_task"/);
  assert.match(queuedSource, /verification: verification/);
  assert.match(dialogSource, /A concrete outcome and verification evidence are required/);
  assert.doesNotMatch(dialogSource, /\b(?:alert|confirm|prompt)\s*\(/);
});

