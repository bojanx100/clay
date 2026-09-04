var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

// Regression: the canonical Coop composer hid the shared config chip, making
// its restart, model, and provider controls unreachable after hydration.
// Found by live desktop QA on 2026-08-13.

test("the canonical Coop composer keeps its incarnation controls reachable", function () {
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "input.css"), "utf8");

  assert.doesNotMatch(css, /body\.coop-home-active #config-chip-wrap\s*\{/);
  assert.match(css, /body\.coop-home-active #vendor-toggle-wrap\s*\{/);
});
