var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var moduleUrl = require("node:url").pathToFileURL;
var fixture = require("./helpers/coordinator-report-fixture").fixture;
var settled = require("./helpers/coordinator-report-fixture").settled;
var stateForClient = require("../lib/orchestration-task-state").orchestrationStateForClient;

function element(tag) {
  var classes = new Set();
  var node = { tagName: tag, children: [], listeners: {}, style: {}, attributes: {},
    appendChild: function (child) { this.children.push(child); return child; },
    setAttribute: function (key, value) { this.attributes[key] = value; },
    addEventListener: function (name, callback) { this.listeners[name] = callback; },
    focus: function () {}, querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    classList: { add: function (name) { classes.add(name); }, remove: function (name) { classes.delete(name); },
      contains: function (name) { return classes.has(name); } } };
  return node;
}

function descendants(node) {
  return node.children.reduce(function (all, child) { return all.concat(child, descendants(child)); }, []);
}

async function client(name) { return import(moduleUrl(path.join(__dirname, "../lib/public/modules", name)).href); }

test("actual report projection renders review controls and resolves the original session through the authorized message handler", async function (t) {
  var f = fixture(t);
  f.failure = "push-throw";
  f.deliver();
  await settled();
  var state = stateForClient(f.session);
  assert.equal(state.coordinatorUpdates.attention.length, 1);
  var originalId = f.session.localId;
  f.session.ownerId = "owner";
  f.session.sessionVisibility = "private";
  var other = f.sm.createSessionRaw({ title: "Other conversation", ownerId: "owner" });
  var users = [{ id: "owner", role: "user" }, { id: "outsider", role: "user" }];
  var usersApi = require("../lib/users-permissions").attachPermissions({
    findUserById: function (id) { return users.find(function (user) { return user.id === id; }); } });
  usersApi.isMultiUser = function () { return true; };
  var access = require("../lib/project-user-message-access").attachProjectUserMessageAccess({
    sm: f.sm, usersModule: usersApi, slug: "lead", opts: {},
    getSessionForWs: function (ws) { return f.sm.sessions.get(ws._clayActiveSession); } });
  var errors = [];
  var handler = require("../lib/project-user-message-handlers").attachProjectUserMessageHandlers({
    getSessionForMessage: access.getSessionForMessage, resolveCoordinatorUpdates: f.api.resolveCoordinatorUpdates,
    sendTo: function (_ws, message) { errors.push(message); } });
  var denied = { _clayUser: users[1], _clayActiveSession: other.localId };
  handler.handleAuxiliaryMessage(denied, { type: "resolve_coordinator_updates", sessionId: originalId,
    action: "acknowledge", updateIds: state.coordinatorUpdates.attention.map(function (entry) { return entry.updateId; }) });
  assert.equal(errors.length, 1);
  assert.equal(f.session.pendingCoordinatorUpdates.length, 1, "the real session access predicate refuses another user");

  var previous = globalThis.document;
  var ids = {};
  ["confirm-modal", "confirm-text", "confirm-ok", "confirm-cancel"].forEach(function (id) { ids[id] = element("div"); });
  ids["confirm-modal"].classList.add("hidden");
  globalThis.document = { createElement: element, getElementById: function (id) { return ids[id]; } };
  t.after(function () { globalThis.document = previous; });
  var store = (await client("store.js")).store;
  var transport = await client("ws-ref.js");
  var modal = await client("confirm-modal.js");
  var view = await client("coordinator-update-notice.js");
  modal.initConfirmModal();
  var actor = { _clayUser: users[0], _clayActiveSession: originalId };
  var sent = [];
  transport.setWs({ readyState: 1, send: function (raw) {
    var message = JSON.parse(raw);
    sent.push(message);
    handler.handleAuxiliaryMessage(actor, message);
  } });
  t.after(function () { transport.setWs(null); });
  store.set({ activeSessionId: originalId });
  var host = element("div");
  view.renderCoordinatorUpdateNotice(host, state);
  var nodes = descendants(host);
  assert.match(nodes.find(function (node) { return node.tagName === "summary"; }).textContent, /needs review/);
  assert.match(nodes.find(function (node) { return node.tagName === "pre"; }).textContent, /report-1/);
  var retry = nodes.find(function (node) { return node.textContent === "Retry reports"; });
  retry.listeners.click();
  ids["confirm-cancel"].listeners.click();
  assert.equal(sent.length, 0, "cancel does not resolve or resend reports");
  var review = nodes.find(function (node) { return node.textContent === "Mark reviewed"; });
  review.listeners.click();
  store.set({ activeSessionId: other.localId });
  actor._clayActiveSession = other.localId;
  ids["confirm-ok"].listeners.click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, originalId);
  assert.equal(actor._clayActiveSession, other.localId, "confirmation does not switch the owner back to an old conversation");
  assert.equal(f.session.pendingCoordinatorUpdates.length, 0);
  assert.equal(other.pendingCoordinatorUpdates, undefined);
  assert.equal(errors.length, 1);
  var after = element("div");
  view.renderCoordinatorUpdateNotice(after, stateForClient(f.session));
  assert.equal(after.children.length, 0);
});
