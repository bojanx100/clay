var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// Reproduction context: /Users/bojansubotic/.clay/images/-Users-bojansubotic--clay-lead-workspace/1786108870859-f6288a96ea561c2d.png
// Topic "Uncategorised conversations" is selected in the sidebar (canonical
// TopicRef "uncategorised-conversations") and the top chat header reads "Coop".
//
// Contract: Coop is the application identity, but the chat header names what the
// owner is reading. A selected TopicRef must show that topic's canonical
// human-readable title; All / Coop home may show "Coop".
//
// This drives the real applier against the real store and projection, and
// re-checks the heading after every repaint that used to overwrite it.

var TOPIC_ID = "uncategorised-conversations";
var TOPIC_TITLE = "Uncategorised conversations";

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function el(id) {
  return {
    id: id,
    textContent: "",
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
  };
}

// Loaded without cache-busting so the applier, the projection and this test all
// share one store instance. Isolation comes from createStore per test.
async function load() {
  var nodes = { "header-title": el("header-title"), "title-bar-project-name": el("title-bar-project-name") };
  globalThis.document = {
    getElementById: function (id) { return nodes[id] || null; },
    createElement: function () { return el(""); },
    body: { classList: { contains: function () { return false; }, add: function () {}, remove: function () {} } },
  };
  var storeModule = await import(modulePath("store.js"));
  storeModule.createStore({ currentSlug: "lead", activeCoopHome: true, projectName: "Coop" });
  var projection = await import(modulePath("global-coop-projection.js"));
  var header = await import(modulePath("coop-header.js"));
  projection.setGlobalCoopProjection(null);
  return { store: storeModule.store, projection: projection, header: header, nodes: nodes };
}

function projectionWith(title) {
  return {
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [],
    topics: [
      { topicRef: { topicId: TOPIC_ID }, title: title, group: "uncategorised", status: "quiet" },
      { topicRef: { topicId: "codex-authentication" }, title: "Codex authentication", group: "uncategorised", status: "quiet" },
    ],
  };
}

function selectTopic(ctx) {
  ctx.store.set({
    activeCoopLens: { projectRef: null, topicRef: { topicId: TOPIC_ID }, title: TOPIC_TITLE },
    activeCoopTopicRef: { topicId: TOPIC_ID },
    activeCoopProjectRef: null,
  });
}

function selectAll(ctx) {
  ctx.store.set({ activeCoopLens: null, activeCoopTopicRef: null, activeCoopProjectRef: null });
}

test("a selected topic names the chat header, not Coop", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  selectTopic(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE);
  assert.notEqual(ctx.nodes["header-title"].textContent, "Coop");
  // The title bar still names the project.
  assert.equal(ctx.nodes["title-bar-project-name"].textContent, "Coop");
});

test("All shows Coop, and switching between All and a topic tracks both ways", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  selectAll(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, "Coop");
  selectTopic(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE);
  selectAll(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, "Coop");
  selectTopic(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE);
});

test("no later repaint overwrites the topic title", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  selectTopic(ctx);

  // 1. Session switch -- selecting a topic replays the canonical Coop session,
  //    so this handler always fires right after the lens is set.
  ctx.header.applyCoopChatHeader("Coop", "Clay");
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE, "session switch overwrote the topic");

  // 2. Sidebar render, which passes the active session's title.
  ctx.header.applyCoopChatHeader("Coop", "Coop");
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE, "sidebar render overwrote the topic");

  // 3. Info frame on reconnect, which passes the project name.
  ctx.header.applyCoopChatHeader("Coop", "Clay");
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE, "info frame overwrote the topic");

  // 4. A project-channel session switch carrying another project's title.
  ctx.header.applyCoopChatHeader("Clay", "Clay");
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE, "project title overwrote the topic");

  // 5. Projection refresh with the same canonical title.
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE, "projection refresh overwrote the topic");
});

test("delayed projection delivery resolves the heading when the record lands", async function () {
  var ctx = await load();
  // History/URL restoration puts the lens back before the projection arrives.
  ctx.store.set({
    activeCoopLens: { projectRef: null, topicRef: { topicId: TOPIC_ID }, title: TOPIC_ID },
    activeCoopTopicRef: { topicId: TOPIC_ID },
  });
  // The snapshot is the raw id, so it must not be shown; the application
  // identity stands in until the canonical record resolves.
  assert.equal(ctx.nodes["header-title"].textContent, "Coop");

  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE,
    "the heading must repaint when the delayed projection carries the canonical title");
});

test("a canonical rename repaints the heading without reselecting", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionWith("Working name"));
  selectTopic(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, "Working name");
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE);
});

test("the heading survives reconnect: projection wiped, lens kept, projection back", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  selectTopic(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE);

  // Socket drops: the projection is cleared but the lens is still selected. The
  // lens snapshot is a real human title, so it bridges the gap -- the heading
  // holds rather than flickering to "Coop" and back while the socket is down.
  ctx.projection.setGlobalCoopProjection(null);
  ctx.header.applyCoopChatHeader("Coop", "Clay");
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE,
    "a selected topic must not revert to Coop during a reconnect blip");

  // Reconnect delivers the projection again; the canonical record takes over.
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE, "reconnect must restore the topic title");
});

test("only an id-shaped snapshot falls back to the identity, never a real title", async function () {
  var ctx = await load();
  // No projection, snapshot is the raw TopicRef id -> not owner-facing text.
  ctx.store.set({
    activeCoopLens: { projectRef: null, topicRef: { topicId: TOPIC_ID }, title: TOPIC_ID },
    activeCoopTopicRef: { topicId: TOPIC_ID },
  });
  assert.equal(ctx.nodes["header-title"].textContent, "Coop");

  // No projection, snapshot is a real title -> shown.
  var ctx2 = await load();
  ctx2.store.set({
    activeCoopLens: { projectRef: null, topicRef: { topicId: TOPIC_ID }, title: TOPIC_TITLE },
    activeCoopTopicRef: { topicId: TOPIC_ID },
  });
  assert.equal(ctx2.nodes["header-title"].textContent, TOPIC_TITLE);
});

test("the heading survives restart: fresh store, lens restored from history", async function () {
  var ctx = await load();
  // A restart begins with the pre-connect paint (project identity only)...
  ctx.header.applyCoopChatHeader("Coop", "Coop");
  assert.equal(ctx.nodes["header-title"].textContent, "Coop");
  // ...then the projection and the restored lens arrive in either order.
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  selectTopic(ctx);
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE);

  // And the reverse order, which is the one that used to lose.
  var ctx2 = await load();
  selectTopic(ctx2);
  ctx2.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  assert.equal(ctx2.nodes["header-title"].textContent, TOPIC_TITLE);
});

test("browser-history restoration lands on the topic title after the server confirms", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionWith(TOPIC_TITLE));
  // A back/forward that restores ?coopTopic= goes through the real selection
  // protocol: the client asks, the server validates, and only then is the lens
  // committed. The heading must follow that commit, not the request.
  globalThis.location = { pathname: "/p/lead/", search: "?coopTopic=" + TOPIC_ID };
  ctx.store.set({ activeCoopLens: null, activeCoopTopicRef: null, activeCoopProjectRef: null, pendingCoopSelection: null });
  assert.equal(ctx.nodes["header-title"].textContent, "Coop", "no lens yet, so the identity shows");

  var sent = [];
  var accepted = ctx.projection.syncCoopLensFromUrl(function (m) { sent.push(m); return true; });
  assert.ok(accepted);
  assert.deepEqual(sent.map(function (m) { return m.type; }), ["coop_topic_select"]);
  // Fail-closed: nothing is committed until the server answers.
  assert.equal(ctx.nodes["header-title"].textContent, "Coop");

  ctx.projection.handleCoopTopicSelected({
    type: "coop_topic_selected",
    topicRef: { topicId: TOPIC_ID },
    projectRef: null,
    ok: true,
  });
  assert.equal(ctx.nodes["header-title"].textContent, TOPIC_TITLE,
    "the restored lens must name the header once the server confirms it");
});

test("an ordinary project is unaffected: its session title still names the header", async function () {
  var ctx = await load();
  ctx.store.set({ currentSlug: "clay", activeCoopHome: false, projectName: "Clay" });
  ctx.header.applyCoopChatHeader("Restore mobile switcher", "Clay");
  assert.equal(ctx.nodes["header-title"].textContent, "Restore mobile switcher");
  ctx.header.applyCoopChatHeader("", "Clay");
  assert.equal(ctx.nodes["header-title"].textContent, "Clay");
});

test("a project lens is a filter over Coop, so it keeps the application identity", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection({
    type: "global_coop_projection", coop: { localId: 7 },
    projects: [{ projectRef: { projectId: "p1" }, slug: "clay", title: "Clay", topics: [] }],
    topics: [],
  });
  ctx.store.set({
    activeCoopLens: { projectRef: { projectId: "p1" }, topicRef: null, title: "Clay" },
    activeCoopTopicRef: null,
    activeCoopProjectRef: { projectId: "p1" },
  });
  assert.equal(ctx.nodes["header-title"].textContent, "Coop");
});
