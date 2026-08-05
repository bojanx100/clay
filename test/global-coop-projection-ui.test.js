var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadProjectionUi() {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js");
  return import(pathToFileURL(modulePath).href + "?v=" + Date.now());
}

function project(projectId, slug, title) {
  return {
    projectRef: { projectId: projectId },
    slug: slug,
    title: title,
    channel: { sessionRef: { projectId: "system-lead", sessionStorageId: "channel-" + slug }, localId: 12 },
    summary: {
      goals: ["Ship " + title],
      decisions: ["Use the canonical project"],
      activeWork: [{ title: "Active task", status: "running", activity: "Implementing" }],
      attention: [],
      outcomes: [{ summary: "Verified previous release" }],
      freshness: { updatedAt: 10, stale: false },
      nextAction: "Open this project channel to review active delegated work.",
    },
  };
}

test("global Coop display model preserves only project channels and bounded summaries", async function () {
  var ui = await loadProjectionUi();
  ui.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { title: "Coop", sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" }, localId: 1 },
    projects: [project("11111111-1111-5111-8111-111111111111", "clay", "Clay")],
  });

  var model = ui.buildGlobalCoopDisplayModel("active");
  assert.equal(model.hasProjection, true);
  assert.equal(model.projects.length, 1);
  assert.equal(model.projects[0].summary.activeWork[0].title, "Active task");
  assert.equal(Object.hasOwn(model.projects[0], "coordinators"), false);
  assert.equal(Object.hasOwn(model.projects[0], "directLeaves"), false);
});

test("opening a project summary uses its durable Lead channel without resolving project sessions", async function () {
  var ui = await loadProjectionUi();
  var sent = [];
  var target = project("11111111-1111-5111-8111-111111111111", "clay", "Clay");
  assert.equal(ui.requestProjectChannel(target, function (message) { sent.push(message); return true; }), true);
  assert.deepEqual(sent, [{ type: "switch_session", id: 12 }]);
});

test("Lead renderers contain project summaries, not copied project session trees or worker attempts", function () {
  var desktop = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8");
  var mobile = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8");
  var projection = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js"), "utf8");

  assert.match(desktop, /Open canonical project/);
  assert.match(desktop, /Open project channel/);
  assert.match(mobile, /Open canonical project/);
  assert.match(mobile, /Open project channel/);
  assert.doesNotMatch(desktop, /appendProjectedAttempts/);
  assert.doesNotMatch(mobile, /appendMobileProjectedAttempts/);
  assert.match(desktop, /store\.get\("currentSlug"\) !== "lead"\) updateCountdowns\(\)/);
  assert.doesNotMatch(projection, /requestGlobalSessionRef/);
  assert.doesNotMatch(projection, /toggleGlobalTaskExpanded/);
});
