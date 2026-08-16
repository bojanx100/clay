// The explicit Thread decision surface is intentionally retired. These tests
// pin the compatibility shim and the live app wiring so a card cannot return
// through a stale import or an accidental DOM builder.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var surface = read("lib/public/modules/coop-topic-decision-surface.js");

test("the retired surface is a no-op and creates no lifecycle card", function () {
  assert.match(surface, /buildTopicDecisionSurface\(\)\s*\{\s*return null;/);
  assert.match(surface, /renderCoopTopicDecisionSurface\(\)/);
  assert.doesNotMatch(surface, /createActionDecisionPanel|createTopicDecisionPanel|createThreadControls/);
});

test("the app no longer imports the explicit decision surface", function () {
  var sessions = read("lib/public/modules/app-messages-sessions.js");
  assert.doesNotMatch(sessions, /coop-topic-decision-surface/);
  assert.doesNotMatch(sessions, /handleTopicDispositionResult/);
});

test("Thread rows are navigation-only on desktop and mobile", function () {
  var desktop = read("lib/public/modules/sidebar-coop-topics.js");
  var mobile = read("lib/public/modules/sidebar-mobile.js");
  assert.doesNotMatch(desktop, /createTopicMenu|sidebar-coop-topic-close/);
  assert.doesNotMatch(mobile, /createTopicMenu|sidebar-coop-topic-close/);
});

test("lifecycle intent is server-side and exact-target gated", function () {
  var ingress = read("lib/coop-topic-ingress.js");
  var intent = read("lib/coop-thread-intent.js");
  assert.match(ingress, /explicitTarget/);
  assert.match(ingress, /threadIntent\.parse/);
  assert.match(intent, /Which Thread should I apply that to/);
  assert.match(intent, /threadRef/);
});
