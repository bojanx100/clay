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
    channel: { sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" }, localId: 12, isLens: true },
    summary: {
      goals: ["Ship " + title],
      decisions: ["Use the canonical project"],
      activeWork: [{ title: "Active task", status: "running", activity: "Implementing" }],
      attention: [],
      outcomes: [{ summary: "Verified previous release" }],
      freshness: { updatedAt: 10, stale: false },
      nextAction: "Open this project channel to review active delegated work.",
      metrics: { activeCoordinators: 1, activeWorkers: 2, health: "active" },
      coordinatorTree: [{
        sessionRef: { projectId: projectId, sessionStorageId: "coordinator-" + slug },
        title: "Canonical coordinator",
        role: "project_coordinator",
        status: "running",
        children: [{
          sessionRef: { projectId: projectId, sessionStorageId: "worker-" + slug },
          title: "Canonical worker",
          role: "task_coordinator",
          status: "running",
          children: [],
        }],
      }],
    },
  };
}

test("global Coop display model keeps project-grouped topic references", async function () {
  var ui = await loadProjectionUi();
  ui.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { title: "Coop", sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" }, localId: 1 },
    projects: [project("11111111-1111-5111-8111-111111111111", "clay", "Clay")],
  });

  var model = ui.buildGlobalCoopDisplayModel("clay");
  assert.equal(model.hasProjection, true);
  assert.equal(model.projects.length, 1);
  assert.equal(model.projects[0].summary.activeWork[0].title, "Active task");
  assert.equal(Object.hasOwn(model.projects[0], "coordinators"), false);
  assert.equal(Object.hasOwn(model.projects[0], "directLeaves"), false);
});

test("opening a project lens validates the permanent main Coop destination", async function () {
  var ui = await loadProjectionUi();
  var sent = [];
  var target = project("11111111-1111-5111-8111-111111111111", "clay", "Clay");
  ui.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { title: "Coop", sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" }, localId: 12 },
    projects: [target],
  });
  assert.equal(ui.requestProjectChannel(target, function (message) { sent.push(message); return true; }), true);
  assert.deepEqual(sent, [{
    type: "coop_topic_select", topicRef: null, projectRef: target.projectRef, historyScope: "canonical",
  }]);
});

test("control rows retain role context and deduplicate retry sessions by canonical work identity", async function () {
  var ui = await loadProjectionUi();
  var projectId = "11111111-1111-5111-8111-111111111111";
  ui.setGlobalCoopProjection({
    type: "global_coop_projection", projects: [], topics: [],
    controlPlaneSessions: [{
      role: "council", title: "Council challenge for workspace context", status: "completed",
      sessionRef: { projectId: projectId, sessionStorageId: "council-first" },
      canonicalKey: "task:" + projectId + ":workspace-context", projectRef: { projectId: projectId },
      projectTitle: "Clay", question: "Which workspace evidence should drive the owner row?",
    }, {
      role: "council", title: "Council challenge for workspace context", status: "running", processing: true,
      sessionRef: { projectId: projectId, sessionStorageId: "council-retry" },
      canonicalKey: "task:" + projectId + ":workspace-context", projectRef: { projectId: projectId },
      projectTitle: "Clay", question: "Which workspace evidence should drive the owner row?",
    }],
    controlPlaneResults: [{
      role: "triage", title: "Triage evidence review for workspace context", status: "completed",
      summary: "The compacted ingress title was never hydrated.", projectRef: { projectId: projectId },
      projectTitle: "Clay", question: "Is the owner request recoverable after compaction?",
      canonicalKey: "task:" + projectId + ":workspace-triage",
      executionRef: { projectId: projectId, sessionStorageId: "triage-result" },
    }],
  });
  var model = ui.buildGlobalCoopDisplayModel("");
  assert.equal(model.controlPlaneSessions.length, 1);
  assert.equal(model.controlPlaneSessions[0].sessionRef.sessionStorageId, "council-retry");
  assert.equal(model.controlPlaneSessions[0].projectTitle, "Clay");
  assert.equal(model.controlPlaneSessions[0].question,
    "Which workspace evidence should drive the owner row?");
  assert.equal(model.controlPlaneResults[0].title, "Triage evidence review for workspace context");
  assert.equal(model.controlPlaneResults[0].projectTitle, "Clay");
  assert.equal(model.controlPlaneResults[0].question,
    "Is the owner request recoverable after compaction?");
});

test("project lens URLs preserve the exact Coop lens for browser history", async function () {
  var ui = await loadProjectionUi();
  var ref = { projectId: "11111111-1111-5111-8111-111111111111" };
  assert.equal(
    ui.projectLensPath("/p/lead/", "?keep=1", ref),
    "/p/lead/?keep=1&coopProject=11111111-1111-5111-8111-111111111111"
  );
  assert.equal(ui.projectLensPath("/p/lead/", "?keep=1&coopProject=old", null), "/p/lead/?keep=1");
});

test("desktop and mobile Coop renderers share the persistent project coordinator hierarchy", function () {
  var desktop = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8");
  var mobile = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8");
  var projection = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js"), "utf8");
  var topics = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topics.js"), "utf8");
  var hierarchy = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-hierarchy.js"), "utf8");
  var model = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions-model.js"), "utf8");
  var desktopCss = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"), "utf8");
  var mobileCss = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"), "utf8");

  // Both surfaces render through the one shared section builder, so the flat
  // control-plane order cannot drift between them.
  assert.match(desktop, /renderCoopTopicSections/);
  assert.match(mobile, /renderCoopTopicSections/);
  assert.doesNotMatch(topics, /global-coop-project-heading/);
  assert.match(topics, /appendControlPlaneSession/);
  assert.match(topics, /renderCoopProjectHierarchy/);
  assert.match(hierarchy, /coop-project-coordinator-row/);
  assert.match(hierarchy, /var prefix = opts\.mobile \? "mobile-" : ""/);
  assert.match(desktopCss, /\.coop-project-coordinator-row/);
  assert.match(mobileCss, /\.mobile-coop-project-coordinator-row/);
  assert.match(hierarchy, /"owner_request_hierarchy"/);
  assert.match(model, /sessionsForOrdinaryProjectSidebar/);
  assert.match(desktop, /buildSessionListModel/);
  assert.match(mobile, /sessionsForOrdinaryProjectSidebar/);
  assert.doesNotMatch(desktop, /Open canonical project|appendProjectedSessionTree|requestCanonicalSession|requestProjectChannel/);
  assert.doesNotMatch(mobile, /Open canonical project|appendMobileProjectedSessionTree|requestCanonicalSession|requestProjectChannel/);
  assert.match(desktop, /store\.get\("currentSlug"\) !== "lead"\) updateCountdowns\(\)/);
  assert.match(projection, /requestCanonicalSession/);
  assert.doesNotMatch(projection, /toggleGlobalTaskExpanded/);
});
