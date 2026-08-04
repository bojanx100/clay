var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "../lib/public/modules", file), "utf8");
}

test("the sidebar exposes no ordinary close, move, delete, or group-clear path for Coop home", function () {
  var deleteSource = source("sidebar-sessions-delete.js");
  var menuSource = source("sidebar-sessions-context-menu.js");
  var listSource = source("sidebar-sessions.js");

  assert.match(deleteSource, /if \(session\.coopHome\) return;/);
  assert.match(menuSource, /!isPermanentCoopHome/);
  assert.match(listSource, /if \(cachedSessions\[si\]\.coopHome\) protectedIds/);
  assert.match(listSource, /createSessionGroupHeader\(group\.name, deletableIds\)/);
});

test("the project router rejects moving Coop home even for an authorized client", function () {
  var messages = [];
  var home = { localId: 7, coopHome: true };
  var sm = { sessions: new Map([[home.localId, home]]) };
  var api = require("../lib/project-sessions-projects").attachProjectSessionsProjects({
    cwd: process.cwd(),
    slug: "lead",
    osUsers: false,
    sm: sm,
    sendTo: function (ws, message) { messages.push(message); },
    opts: {},
    usersModule: {},
  });

  assert.strictEqual(api.handleProjectMessage({}, {
    type: "move_session_to_project",
    id: home.localId,
    toSlug: "clay",
  }), true);
  assert.match(messages[0].text, /cannot be moved/);
  assert.strictEqual(sm.sessions.get(home.localId), home);
});
