var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("worker preview defaults to one compact expandable row", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "../lib/public/modules/orchestration-task-preview.js"),
    "utf8"
  );
  var css = fs.readFileSync(
    path.join(__dirname, "../lib/public/css/input.css"),
    "utf8"
  );

  assert.match(source, /var MAX_PREVIEW_WORKERS = 3/);
  assert.match(source, /summary\.setAttribute\("aria-expanded", isExpanded \? "true" : "false"\)/);
  assert.match(source, /store\.set\(\{ orchestrationTaskPreviewExpanded: !isExpanded \}\)/);
  assert.match(source, /if \(!store\.get\("orchestrationTaskPreviewExpanded"\)\) \{/);
  assert.match(source, /metrics\.completed \+ " completed"/);
  assert.match(css, /\.orchestration-task-summary\s*\{[^}]*min-height:\s*42px[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(240px,\s*30dvh\)[^}]*overflow-y:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.orchestration-task-list\s*\{[^}]*max-height:\s*min\(168px,\s*22dvh\)/);
});
