var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("icon strip status dot is visible only while processing", function () {
  var css = fs.readFileSync(
    path.join(__dirname, "../lib/public/css/icon-strip.css"),
    "utf8"
  );

  assert.doesNotMatch(css, /\.icon-strip-(?:item|wt-item|mate)\.active \.icon-strip-status/);
  assert.match(css, /\.icon-strip-status\.processing\s*\{[^}]*opacity:\s*1/s);
});
