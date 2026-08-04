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

  assert.match(deleteSource, /session\.coopHome \|\| session\.coopChannel/);
  assert.match(menuSource, /!isPermanentCoopConversation/);
  assert.match(menuSource,
    /!isPermanentCoopConversation && store\.get\('isMultiUserMode'\)/);
  assert.match(menuSource,
    /if \(!isPermanentCoopConversation\) \{\s+var bookmarkItem/);
  assert.match(listSource, /cachedSessions\[si\]\.coopHome \|\| cachedSessions\[si\]\.coopChannel/);
  assert.match(listSource,
    /if \(!s\.coopHome && !s\.coopChannel\) setupSessionDragHandlers/);
  assert.match(listSource, /createSessionGroupHeader\(group\.name, deletableIds\)/);
  var channelSource = source("sidebar-coop-channels.js");
  assert.match(channelSource, /sidebarTitle: "All Projects"/);
  assert.match(channelSource, /matchesProjectSearch\(project, query\)/);
  assert.match(channelSource, /type: "refresh_coop_channels"/);
  assert.match(listSource, /waitForCoopSessionMetadata\(cachedSessions/);
});

test("the project router rejects moving Coop home and channels", function () {
  var messages = [];
  var home = { localId: 7, coopHome: true };
  var channel = {
    localId: 8,
    coopChannel: { projectSlug: "clay", projectTitle: "Clay" },
  };
  var sm = { sessions: new Map([[home.localId, home], [channel.localId, channel]]) };
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
  assert.strictEqual(api.handleProjectMessage({}, {
    type: "move_session_to_project",
    id: channel.localId,
    toSlug: "clay",
  }), true);
  assert.match(messages[1].text, /cannot be moved/);
  assert.strictEqual(sm.sessions.get(channel.localId), channel);
});
