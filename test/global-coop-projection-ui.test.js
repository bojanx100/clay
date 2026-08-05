var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function loadProjectionUi() {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js");
  return import(pathToFileURL(modulePath).href);
}

function ref(projectId, storageId) {
  return { projectId: projectId, sessionStorageId: storageId };
}

function taskRef(projectId, storageId, taskId) {
  return {
    projectId: projectId,
    coordinatorSessionStorageId: storageId,
    taskId: taskId,
  };
}

test("global Coop model excludes local Coop and preserves server project order", async function () {
  var ui = await loadProjectionUi();
  ui.setGlobalCoopProjection({
    type: "global_coop_projection",
    projects: [{
      projectRef: { projectId: "system-lead" },
      title: "Lead",
    }, {
      projectRef: { projectId: "project-clay" },
      title: "Clay",
      coordinators: [],
      directLeaves: [],
      worktrees: [],
    }, {
      projectRef: { projectId: "project-webapp" },
      title: "Webapp",
      coordinators: [],
      directLeaves: [],
      worktrees: [],
    }],
  });

  var model = ui.buildGlobalCoopDisplayModel("");
  assert.equal(Object.prototype.hasOwnProperty.call(model, "coop"), false);
  assert.deepEqual(model.projects.map(function (project) { return project.title; }), ["Clay", "Webapp"]);
});

test("global Coop model keeps active work visible and terminal attempts collapsed by default", async function () {
  var ui = await loadProjectionUi();
  ui.setGlobalCoopProjection({
    type: "global_coop_projection",
    projects: [{
      projectRef: { projectId: "project-clay" },
      title: "Clay",
      coordinators: [{
        sessionRef: ref("project-clay", "coordinator"),
        title: "Clay coordinator",
        role: "coordinator",
        tasks: [{
          taskRef: taskRef("project-clay", "coordinator", "active-task"),
          status: "needs_input",
          attention: true,
          activity: "Choose an owner",
          attempts: [{
            sessionRef: ref("project-clay", "current-worker"),
            title: "Current worker",
            availability: "available",
            current: true,
            historical: false,
          }, {
            sessionRef: ref("project-clay", "old-worker"),
            title: "Earlier worker",
            availability: "available",
            current: false,
            historical: true,
          }],
        }, {
          taskRef: taskRef("project-clay", "coordinator", "done-task"),
          status: "completed",
          attempts: [{
            sessionRef: ref("project-clay", "done-worker"),
            title: "Completed worker",
            availability: "available",
            current: true,
            historical: false,
          }],
        }],
      }],
      directLeaves: [],
      worktrees: [],
    }],
  });

  var coordinator = ui.buildGlobalCoopDisplayModel("").projects[0].coordinators[0];
  assert.equal(coordinator.visibleTasks.length, 1);
  assert.equal(coordinator.visibleTasks[0].currentAttempts.length, 1);
  assert.equal(coordinator.visibleTasks[0].historicalAttempts.length, 1);
  assert.equal(coordinator.terminalTasks.length, 1);
  assert.equal(coordinator.terminalTasks[0].terminal, true);
  assert.equal(ui.isGlobalTaskExpanded(coordinator.terminalTasks[0].taskRef), false);
});

test("stable SessionRef navigation records failures without synthesizing a target", async function () {
  var ui = await loadProjectionUi();
  var target = ref("project-clay", "restart-safe");
  var competingTarget = ref("project-webapp", "another-worker");
  var sent = [];
  assert.equal(ui.requestGlobalSessionRef(target, function (message) { sent.push(message); return true; }), true);
  assert.equal(ui.requestGlobalSessionRef(competingTarget, function () { return true; }), false);
  assert.deepEqual(sent, [{ type: "resolve_session_ref", sessionRef: target }]);
  assert.deepEqual(ui.consumeGlobalSessionRefResolution({
    type: "session_ref_resolved",
    ok: false,
    code: "access_denied",
  }), { ok: false, ref: target, code: "access_denied" });

  assert.equal(ui.requestGlobalSessionRef(target, function () { return true; }), true);
  assert.deepEqual(ui.consumeGlobalSessionRefResolution({
    type: "session_ref_resolved",
    ok: true,
    sessionRef: target,
    slug: "clay-renamed",
    localId: 42,
  }), { ok: true, ref: target, slug: "clay-renamed", localId: 42 });
});

test("Lead renderers consume the global projection rather than local Coop channel rows", function () {
  var desktop = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8");
  var mobile = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8");
  var desktopCss = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"), "utf8");
  var mobileCss = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"), "utf8");

  assert.match(desktop, /buildGlobalCoopDisplayModel/);
  assert.match(desktop, /createCanonicalCoopRow/);
  assert.match(desktop, /session\.coopHome/);
  assert.doesNotMatch(desktop, /createCoopChannelsSection/);
  assert.match(desktop, /createLeadAutomationSection/);
  assert.match(mobile, /renderMobileGlobalCoopSessions/);
  assert.match(mobile, /createMobileCanonicalCoopRow/);
  assert.match(mobile, /requestGlobalSessionRef/);
  var sessionMessages = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "app-messages-sessions.js"),
    "utf8"
  );
  assert.match(sessionMessages, /currentSlug'\) === "lead"\) sessionSwitchUpdate\.activeGlobalSessionRef = null/);
  assert.match(desktopCss, /\.global-coop-history-toggle/);
  assert.match(mobileCss, /\.mobile-global-coop-history-toggle/);
});
