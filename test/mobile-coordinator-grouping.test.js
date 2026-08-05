var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

test("mobile session sheet nests workers beneath coordinators by default", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile-coordinators.js");
  var coordinatorModule = await import(pathToFileURL(modulePath).href);
  var coordinator = { id: 10, coordinationMode: true, lastActivity: 30 };
  var olderWorker = { id: 11, orchestrationGroupParent: { sessionId: 10 }, lastActivity: 10 };
  var newerWorker = { id: 12, orchestrationParent: { sessionId: 10 }, lastActivity: 20 };
  var ordinary = { id: 13, lastActivity: 15 };
  var items = coordinatorModule.buildMobileCoordinatorItems([
    olderWorker,
    ordinary,
    coordinator,
    newerWorker
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].type, "session");
  assert.equal(items[0].data.id, 13);
  assert.equal(items[1].type, "coordinator");
  assert.equal(items[1].data.id, 10);
  assert.deepEqual(items[1].children.map(function (session) { return session.id; }), [12, 11]);
});

test("mobile coordinator grouping leaves orphaned and non-coordinator children visible", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile-coordinators.js");
  var coordinatorModule = await import(pathToFileURL(modulePath).href);
  var ordinaryParent = { id: 20, lastActivity: 30 };
  var ordinaryChild = { id: 21, orchestrationParent: { sessionId: 20 }, lastActivity: 20 };
  var orphanedWorker = { id: 22, orchestrationParent: { sessionId: 999 }, lastActivity: 10 };

  var items = coordinatorModule.buildMobileCoordinatorItems([
    ordinaryParent,
    ordinaryChild,
    orphanedWorker
  ]);

  assert.deepEqual(items.map(function (item) { return item.data.id; }), [20, 21, 22]);
  assert.ok(items.every(function (item) { return item.type === "session"; }));
});

test("mobile coordinator grouping prefers the durable group parent", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile-coordinators.js");
  var coordinatorModule = await import(pathToFileURL(modulePath).href);
  var firstCoordinator = { id: 30, coordinationMode: true, lastActivity: 30 };
  var secondCoordinator = { id: 31, coordinationMode: true, lastActivity: 20 };
  var worker = {
    id: 32,
    orchestrationGroupParent: { sessionId: 31 },
    orchestrationParent: { sessionId: 30 },
    lastActivity: 10
  };

  var items = coordinatorModule.buildMobileCoordinatorItems([
    firstCoordinator,
    secondCoordinator,
    worker
  ]);

  assert.equal(items[0].type, "session");
  assert.equal(items[0].data.id, 30);
  assert.equal(items[1].type, "coordinator");
  assert.deepEqual(items[1].children.map(function (session) { return session.id; }), [32]);
});

test("coordinator groups collapse worker overflow behind shared controls", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"),
    "utf8"
  );
  var groupingSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile-coordinators.js"),
    "utf8"
  );
  var desktopSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"),
    "utf8"
  );
  var css = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"),
    "utf8"
  );
  var desktopCss = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"),
    "utf8"
  );

  assert.match(source, /mobile-session-role-badge coordinator/);
  assert.match(source, /mobile-session-role-badge worker/);
  assert.match(source, /"Worker " \+ attempt \+ "\/" \+ attemptCount/);
  assert.match(desktopSource, /"Worker " \+ attempt \+ "\/" \+ attemptCount/);
  assert.match(groupingSource, /var children = document\.createElement\("div"\)/);
  assert.match(groupingSource, /coordinatorWorkerDisplay/);
  assert.match(groupingSource, /mobile-coordinator-workers-toggle/);
  assert.match(desktopSource, /coordinatorWorkerDisplay/);
  assert.match(desktopSource, /session-coordinator-workers-toggle/);
  assert.match(css, /\.mobile-coordinator-workers\s*\{/);
  assert.match(css, /\.mobile-session-item\.mobile-coordinator-worker\s*\{/);
  assert.match(css, /\.mobile-session-item\.mobile-coordinator-parent\s*\{/);
  assert.match(css, /\.mobile-coordinator-workers-toggle/);
  assert.match(desktopCss, /\.session-item\.session-coordinator-parent\s*\{/);
  assert.match(desktopCss, /\.session-coordinator-workers-toggle/);
});

test("mobile and desktop share the labeled legacy and attention projection model", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js");
  var globalProjection = await import(pathToFileURL(modulePath).href);
  globalProjection.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: {
      role: "coop",
      title: "Coop",
      sessionRef: { projectId: "system-lead", sessionStorageId: "coop-home" },
      availability: "available",
    },
    projects: [{
      projectRef: { projectId: "system-target" },
      slug: "target",
      title: "Target",
      coordinators: [],
      directLeaves: [{
        role: "direct_leaf",
        title: "Project execution needs attention",
        status: "needs_input",
        availability: "unavailable",
        attention: true,
      }],
      worktrees: [],
    }, {
      projectRef: { projectId: "system-lead" },
      slug: "lead",
      title: "Legacy Lead workspace",
      legacyLead: true,
      coordinators: [],
      directLeaves: [{
        role: "worker",
        title: "Historical Lead worker",
        status: "completed",
        historical: true,
        sessionRef: { projectId: "system-lead", sessionStorageId: "legacy-worker" },
      }],
      worktrees: [],
    }],
  });

  var model = globalProjection.buildGlobalCoopDisplayModel("");
  assert.equal(Object.prototype.hasOwnProperty.call(model, "coop"), false);
  assert.equal(globalProjection.getGlobalCoopReference().title, "Coop");
  assert.deepEqual(model.projects.map(function (project) { return project.title; }), [
    "Target", "Legacy Lead workspace",
  ]);
  assert.equal(model.projects[0].directLeaves[0].attention, true);
  assert.equal(model.projects[1].legacyLead, true);
  assert.equal(model.projects[1].directLeaves[0].historical, true);

  var mobileSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8"
  );
  var desktopSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8"
  );
  assert.match(mobileSource, /buildGlobalCoopDisplayModel/);
  assert.match(desktopSource, /buildGlobalCoopDisplayModel/);
  assert.match(desktopSource, /global-coop-legacy-lead/);
});
