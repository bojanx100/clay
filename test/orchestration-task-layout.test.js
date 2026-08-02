var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("worker task list cannot squeeze the transcript out of the viewport", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/queued-messages.js"),
    "utf8"
  );
  var css = fs.readFileSync(
    path.join(__dirname, "../lib/public/css/input.css"),
    "utf8"
  );

  assert.match(source, /taskList\.className = "orchestration-task-list"/);
  assert.match(source, /taskList\.appendChild\(row\)/);
  assert.match(css, /\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(240px,\s*30dvh\)[^}]*overflow-y:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(168px,\s*22dvh\)/);
});
