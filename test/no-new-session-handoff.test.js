var assert = require("assert");
var fs = require("fs");
var path = require("path");
var test = require("node:test");

var root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("provider handoff has no separate-session server route", function () {
  var sessions = read("lib/project-sessions.js");
  var schema = read("lib/ws-schema.js");

  assert.doesNotMatch(sessions, /project-session-handoff/);
  assert.doesNotMatch(sessions, /handoff_session_options/);
  assert.doesNotMatch(sessions, /handoffMode\s*===?\s*["']new-session["']/);
  assert.doesNotMatch(schema, /handoff_session_options|session_handoff_result/);
  assert.match(schema, /Switch provider in place while preserving the current Clay session/);
});

test("provider handoff has no separate-session browser action", function () {
  var app = read("lib/public/app.js");
  var messages = read("lib/public/modules/app-messages.js");
  var html = read("lib/public/index.html");

  assert.doesNotMatch(app, /initSessionActions|modules\/session-actions/);
  assert.doesNotMatch(messages, /handleSessionActionMessage|session-actions/);
  assert.doesNotMatch(html, /header-session-actions-btn/);
});
