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

test("Coop role labels switch back to ordinary session language without changing actions", async function () {
  var labels = await import("../lib/public/modules/queued-messages.js");
  var span = { textContent: "" };
  var attributes = { "data-tip": "" };
  var button = {
    title: "",
    querySelector: function () { return span; },
    setAttribute: function (name, value) { attributes[name] = value; },
    hasAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
  };

  labels.applyComposerActionLabels(button, { activeCoopHome: true });
  assert.strictEqual(span.textContent, "Delegate");
  assert.match(attributes["aria-label"], /Delegate/);
  assert.match(button.title, /Delegate/);
  assert.match(attributes["data-tip"], /Delegate/);

  var coopQueue = labels.coopActionLabels({
    activeCoopChannel: { projectSlug: "webapp" },
  });
  assert.strictEqual(coopQueue.queuedCoordinateLabel, "Delegate now");
  assert.strictEqual(coopQueue.queuedCoordinateTitle,
    "Delegate this queued message to a background worker now");
  assert.strictEqual(coopQueue.queuedSteerLabel, "Prioritize");
  assert.strictEqual(coopQueue.queuedSteerTitle,
    "Interrupt the active response and make this queued message the next priority");

  labels.applyComposerActionLabels(button, {
    activeCoopHome: false,
    activeCoopChannel: null,
  });
  assert.strictEqual(span.textContent, "Task");
  assert.strictEqual(attributes["aria-label"], "Send as task");
  assert.strictEqual(button.title, "Send as task (Option/Alt+Enter)");
  var ordinaryQueue = labels.coopActionLabels({});
  assert.strictEqual(ordinaryQueue.queuedCoordinateLabel, "Coordinate");
  assert.strictEqual(ordinaryQueue.queuedCoordinateTitle,
    "Run this in a background worker with conversation context");
  assert.strictEqual(ordinaryQueue.queuedSteerLabel, "Steer");
  assert.strictEqual(ordinaryQueue.queuedSteerTitle,
    "Send this queued message into the active response");

  var sessionSource = source("app-messages-sessions.js");
  var inputSource = source("input.js");
  var queueSource = source("queued-messages.js");
  assert.match(sessionSource, /activeCoopHome: !!msg\.coopHome/);
  assert.match(sessionSource, /activeCoopChannel: msg\.coopChannel \|\| null/);
  assert.match(sessionSource, /syncActiveCoopConversation\(msg\.sessions \|\| \[\]\)/);
  assert.match(queueSource,
    /applyComposerActionLabels\(document\.getElementById\("task-btn"\), state\)/);
  assert.match(queueSource, /state\.activeCoopChannel !== prev\.activeCoopChannel/);
  assert.match(inputSource, /sendMessage\(\{ intent: "task" \}\)/);
  assert.match(queueSource, /type: "coordinate_queued_message"/);
  assert.match(queueSource, /type: "steer_queued_message"/);
});
