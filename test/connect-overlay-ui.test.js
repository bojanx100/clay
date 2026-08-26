var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "../", file), "utf8");
}

test("connection overlay starts with connecting wording", function() {
  var html = source("lib/public/index.html");
  assert.match(html, /id="connect-overlay-msg">Connecting…</);
  assert.doesNotMatch(html, /id="connect-overlay-msg">Reconnecting/);
});

test("reconnect wording is only set after a prior connection", function() {
  var connection = source("lib/public/modules/app-connection.js");
  assert.match(connection, /var hasConnectedOnce = false/);
  assert.match(connection, /if \(hasConnectedOnce && connectOverlay\)[\s\S]*Reconnecting to server…/);
});

test("pane overlays use a quiet themed loading state", function() {
  var css = source("lib/public/css/pane.css");
  assert.match(css, /body\.pane-mode #connect-overlay \{ background: var\(--bg\); \}/);
  assert.match(css, /body\.pane-mode #connect-overlay #ascii-logo-canvas \{ display: none; \}/);
  assert.match(css, /body\.pane-mode #connect-overlay-msg \{ color: var\(--text-dimmer\); \}/);
});
