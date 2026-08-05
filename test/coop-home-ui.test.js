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

test("Coop hides unsupported task controls and keeps Prioritize role language", async function () {
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
  assert.strictEqual(button.hidden, true);
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(attributes["aria-hidden"], "true");
  assert.strictEqual(span.textContent, "Task");
  assert.strictEqual(attributes["aria-label"], "Send as task");
  assert.strictEqual(labels.canUseTaskIntent({ activeCoopHome: true }), false);

  var coopQueue = labels.coopActionLabels({
    activeCoopChannel: { projectSlug: "webapp" },
  });
  assert.strictEqual(coopQueue.queuedCoordinateVisible, false);
  assert.strictEqual(labels.canUseTaskIntent({ activeCoopChannel: {} }), false);
  assert.strictEqual(coopQueue.queuedSteerLabel, "Prioritize");
  assert.strictEqual(coopQueue.queuedSteerTitle,
    "Interrupt the active response and make this queued message the next priority");

  labels.applyComposerActionLabels(button, {
    activeCoopHome: false,
    activeCoopChannel: null,
  });
  assert.strictEqual(button.hidden, false);
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(attributes["aria-hidden"], "false");
  assert.strictEqual(span.textContent, "Task");
  assert.strictEqual(attributes["aria-label"], "Send as task");
  assert.strictEqual(button.title, "Send as task (Option/Alt+Enter)");
  var ordinaryQueue = labels.coopActionLabels({});
  assert.strictEqual(labels.canUseTaskIntent({}), true);
  assert.strictEqual(ordinaryQueue.queuedCoordinateVisible, true);
  assert.strictEqual(ordinaryQueue.queuedCoordinateLabel, "Coordinate");
  assert.strictEqual(ordinaryQueue.queuedCoordinateTitle,
    "Run this in a background worker with conversation context");
  assert.strictEqual(ordinaryQueue.queuedSteerLabel, "Steer");
  assert.strictEqual(ordinaryQueue.queuedSteerTitle,
    "Send this queued message into the active response");

  var sessionSource = source("app-messages-sessions.js");
  var inputSource = source("input.js");
  var queueSource = source("queued-messages.js");
  assert.match(sessionSource, /syncActiveCoopConversation\(msg\.sessions \|\| \[\]\)/);
  assert.match(queueSource,
    /applyComposerActionLabels\(document\.getElementById\("task-btn"\), state\)/);
  assert.match(queueSource, /state\.activeCoopChannel !== prev\.activeCoopChannel/);
  assert.match(inputSource,
    /e\.altKey && canUseTaskIntent\(store\.snap\(\)\) \? "task" : "chat"/);
  assert.match(inputSource,
    /hasSendableContent\(\) && canUseTaskIntent\(store\.snap\(\)\)/);
  assert.match(inputSource,
    /taskIntentAvailable = canUseTaskIntent\(store\.snap\(\)\)/);
  assert.match(queueSource, /if \(!actionLabels\.queuedCoordinateVisible\) return null/);
  assert.match(queueSource, /if \(taskBtn\) row\.appendChild\(taskBtn\)/);
  assert.match(queueSource, /type: "coordinate_queued_message"/);
  assert.match(queueSource, /type: "steer_queued_message"/);
});

test("Delegate stays gated until Coop task intent reaches the canonical project coordinator", async function () {
  var actions = await import("../lib/public/modules/queued-messages.js");
  assert.strictEqual(actions.coopTaskIntentRoutesToCanonicalProjectCoordinator(), false);
  var home = actions.coopActionLabels({ activeCoopHome: true });
  var channel = actions.coopActionLabels({
    activeCoopChannel: { projectSlug: "webapp" },
  });
  assert.strictEqual(home.composerTaskVisible, false);
  assert.strictEqual(home.queuedCoordinateVisible, false);
  assert.strictEqual(channel.composerTaskVisible, false);
  assert.strictEqual(channel.queuedCoordinateVisible, false);

  var queueSource = source("queued-messages.js");
  assert.match(queueSource,
    /return true only after Coop task intent routes[\s\S]*canonical coordinator/);
  assert.match(queueSource,
    /return coopTaskIntentRoutesToCanonicalProjectCoordinator\(\)/);
});
