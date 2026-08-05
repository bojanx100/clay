var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", file), "utf8");
}

test("Lead to Clay synchronous switches clear source rows before the target session list arrives", function () {
  var projects = source("modules/app-projects.js");
  var sessions = source("modules/sidebar-sessions.js");
  var messages = source("modules/app-messages-sessions.js");

  assert.match(projects, /store\.set\(\{ currentSlug: slug \}\);\s+window\.dispatchEvent\(new CustomEvent\("clay:project-switching"/);
  assert.match(sessions, /function prepareSessionListForProject\(slug\) \{\s+cachedSessions = \[\];\s+cachedSessionsSlug = ""/);
  assert.match(sessions, /if \(isSessionListLoading\(\)\) \{[\s\S]*Loading conversations/);
  assert.match(messages, /if \(msg\.projectSlug && msg\.projectSlug !== store\.get\('currentSlug'\)\) return;/);
});

test("Back and Forward use the same target-keyed session cache reset", function () {
  var app = source("app.js");
  assert.match(app, /store\.set\(\{ currentSlug: newSlug \}\);\s+window\.dispatchEvent\(new CustomEvent\("clay:project-switching"/);
});

test("mobile uses the same neutral target loading state and never renders a stale list", function () {
  var mobile = source("modules/sidebar-mobile.js");
  assert.match(mobile, /if \(isSessionListLoading\(\)\) \{[\s\S]*mobile-session-list-target-loading/);
});
