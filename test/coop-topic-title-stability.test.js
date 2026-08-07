var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

// The lens stores refs plus a title snapshot taken when the row was tapped.
// These tests drive the real projection module to prove the displayed title is
// resolved from the canonical record on every read, so it survives a projection
// rebuild, a reconnect that replaces the projection, and a history replay that
// restores a lens from a stale reference.

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

async function load() {
  globalThis.document = {
    createElement: function () { return { style: {}, classList: { add: function () {}, remove: function () {} } }; },
    getElementById: function () { return null; },
  };
  // Loaded without cache-busting so this test and the projection module share
  // one store instance -- the projection resolves the lens through it. Per-test
  // isolation comes from createStore plus a fresh setGlobalCoopProjection.
  var storeModule = await import(modulePath("store.js"));
  storeModule.createStore({ activeCoopHome: true, currentSlug: "lead" });
  var projection = await import(modulePath("global-coop-projection.js"));
  return { store: storeModule.store, projection: projection };
}

function projectionPayload(topicTitle) {
  return {
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [{
      projectRef: { projectId: "project-1" },
      slug: "clay",
      title: "Clay",
      topics: [{
        topicRef: { topicId: "coop-conversation-architecture" },
        title: topicTitle,
        status: "running",
        active: true,
        projectRef: { projectId: "project-1" },
      }],
    }],
    topics: [],
  };
}

test("a selected topic is named by the canonical record, not the click-time snapshot", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionPayload("Coop conversation architecture"));
  // A lens captured when the row said something else -- e.g. before a rename.
  ctx.store.set({
    activeCoopLens: {
      projectRef: { projectId: "project-1" },
      topicRef: { topicId: "coop-conversation-architecture" },
      title: "Uncategorised conversations",
    },
  });
  var display = ctx.projection.activeCoopLensDisplay();
  assert.equal(display.kind, "topic");
  assert.equal(display.title, "Coop conversation architecture");
});

test("a rebuilt projection renames the lens without the owner reselecting", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionPayload("Old working name"));
  ctx.store.set({
    activeCoopLens: {
      projectRef: { projectId: "project-1" },
      topicRef: { topicId: "coop-conversation-architecture" },
      title: "Old working name",
    },
  });
  assert.equal(ctx.projection.activeCoopLensDisplay().title, "Old working name");

  // Reconnect / rebuild delivers the canonical title.
  ctx.projection.setGlobalCoopProjection(projectionPayload("Coop conversation architecture"));
  assert.equal(ctx.projection.activeCoopLensDisplay().title, "Coop conversation architecture");
});

test("a lens restored from history before the projection arrives never shows an id", async function () {
  var ctx = await load();
  // History replay restores refs; the projection has not landed yet.
  ctx.store.set({
    activeCoopLens: {
      projectRef: { projectId: "project-1" },
      topicRef: { topicId: "auto-16009768de45d7073b3c960d" },
      title: "auto-16009768de45d7073b3c960d",
    },
  });
  var display = ctx.projection.activeCoopLensDisplay();
  assert.equal(display.kind, "topic");
  assert.equal(display.title, "Untitled topic");
});

test("a snapshot bridges the gap until the canonical record resolves", async function () {
  var ctx = await load();
  ctx.store.set({
    activeCoopLens: {
      projectRef: { projectId: "project-1" },
      topicRef: { topicId: "coop-conversation-architecture" },
      title: "Coop conversation architecture",
    },
  });
  // No projection yet: the human snapshot is still better than nothing.
  assert.equal(ctx.projection.activeCoopLensDisplay().title, "Coop conversation architecture");
});

test("a project lens is reported as a project and named from the canonical project", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionPayload("Coop conversation architecture"));
  ctx.store.set({
    activeCoopLens: { projectRef: { projectId: "project-1" }, topicRef: null, title: "stale" },
  });
  var display = ctx.projection.activeCoopLensDisplay();
  assert.equal(display.kind, "project");
  assert.equal(display.title, "Clay");
});

test("the All lens reports nothing to caption", async function () {
  var ctx = await load();
  ctx.projection.setGlobalCoopProjection(projectionPayload("Coop conversation architecture"));
  ctx.store.set({ activeCoopLens: null });
  assert.equal(ctx.projection.activeCoopLensDisplay(), null);
});
