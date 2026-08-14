var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;
var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

function session(id, extra) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    title: "Session " + id,
    lastActivity: id,
  }, extra || {});
}

function project(projectId, slug, title, sessions, extra) {
  return Object.assign({
    projectId: projectId,
    slug: slug,
    title: title,
    sm: {
      sessions: new Map(sessions.map(function (item) { return [item.localId, item]; })),
    },
  }, extra || {});
}

function task(taskId, status, child) {
  return {
    taskId: taskId,
    title: child.title,
    status: status,
    externalTaskCoordinator: true,
    workerSessionId: child.localId,
    workerStorageId: child.storageId,
    updatedAt: child.lastActivity,
  };
}

function coordinatorFixture() {
  var coopHome = session(1, { storageId: "coop-home", coopHome: true });
  var lead = project("system-lead", "lead", "Coop", [coopHome], { isLead: true });

  var clayActive = session(12, {
    title: "Show project coordinators in Coop sidebar",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-active", sessionStorageId: "clay-project-coordinator" },
  });
  var clayCompleted = session(13, {
    title: "Completed Clay task",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "clay-completed", sessionStorageId: "clay-project-coordinator" },
  });
  var clayRoot = session(10, {
    storageId: "clay-project-coordinator",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationTasks: [
      task("clay-active", "running", clayActive),
      task("clay-completed", "completed", clayCompleted),
    ],
  });
  var ownerDirect = session(11, {
    title: "Owner-opened direct coordinator",
    coordinationMode: true,
    orchestrationTasks: [],
  });
  var ownerTaskCoordinator = session(14, {
    title: "Owner-opened task coordinator",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    orchestrationParent: { taskId: "owner-task", sessionStorageId: "clay-project-coordinator" },
  });

  var webappAttention = session(22, {
    title: "Resolve Webapp rollout decision",
    coordinationMode: true,
    coordinationRole: "task_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationParent: { taskId: "webapp-attention", sessionStorageId: "webapp-project-coordinator" },
  });
  var webappRoot = session(20, {
    storageId: "webapp-project-coordinator",
    title: "Project coordinator",
    coordinationMode: true,
    coordinationRole: "project_coordinator",
    coopControlledBy: { coopSessionStorageId: "coop-home", since: 1 },
    orchestrationTasks: [task("webapp-attention", "needs_input", webappAttention)],
  });

  return {
    lead: lead,
    clay: project(CLAY, "clay", "Clay", [
      clayRoot, ownerDirect, ownerTaskCoordinator, clayActive, clayCompleted,
    ]),
    webapp: project(WEBAPP, "webapp", "Webapp", [webappRoot, webappAttention]),
    clayActive: clayActive,
    webappAttention: webappAttention,
  };
}

// Regression: ISSUE-COOP-SIDEBAR-001 — project coordinators rendered only in project sidebars.
// Found by /qa on 2026-08-14.
test("global Coop projection keeps one persistent canonical root and only live task coordinators", function () {
  var fixture = coordinatorFixture();
  var projection = buildGlobalCoopProjection({
    projects: [fixture.lead, fixture.clay, fixture.webapp],
  });
  var projects = Object.fromEntries(projection.projects.map(function (item) {
    return [item.projectRef.projectId, item];
  }));

  assert.deepEqual(Object.keys(projects).sort(), [CLAY, WEBAPP].sort());
  assert.equal(projects[CLAY].summary.coordinatorTree.length, 1,
    "the owner-opened direct coordinator is not adopted into Coop");
  assert.equal(projects[CLAY].summary.coordinatorTree[0].role, "project_coordinator");
  assert.equal(JSON.stringify(projects[CLAY].summary.coordinatorTree).includes("Owner-opened"), false,
    "owner-opened sessions are never adopted beneath the Coop root");
  assert.deepEqual(projects[CLAY].summary.coordinatorTree[0].children.map(function (item) {
    return item.title;
  }), ["Show project coordinators in Coop sidebar"],
  "a completed task coordinator is absent while active work remains nested");
  assert.deepEqual(projects[WEBAPP].summary.coordinatorTree[0].children.map(function (item) {
    return item.status;
  }), ["needs_input"]);

  fixture.clayActive.hidden = true;
  fixture.webappAttention.hidden = true;
  projection = buildGlobalCoopProjection({
    projects: [fixture.lead, fixture.clay, fixture.webapp],
  });
  assert.deepEqual(projection.projects.map(function (item) {
    return {
      projectId: item.projectRef.projectId,
      roots: item.summary.coordinatorTree.length,
      children: item.summary.coordinatorTree[0].children.length,
    };
  }), [
    { projectId: CLAY, roots: 1, children: 0 },
    { projectId: WEBAPP, roots: 1, children: 0 },
  ], "terminal child rows close while both reusable project roots persist");
});

function createElement(tag) {
  var node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    className: "",
    type: "",
    _text: "",
  };
  Object.defineProperty(node, "textContent", {
    get: function () {
      if (!node.children.length) return node._text;
      return node.children.map(function (child) { return child.textContent; }).join("");
    },
    set: function (value) { node._text = String(value); node.children = []; },
  });
  node.classList = {
    contains: function (name) { return node.className.split(/\s+/).indexOf(name) !== -1; },
  };
  node.setAttribute = function (name, value) { node.attributes[name] = String(value); };
  node.appendChild = function (child) { node.children.push(child); return child; };
  node.addEventListener = function (name, handler) { node.listeners[name] = handler; };
  return node;
}

function descendants(node) {
  var result = [];
  for (var i = 0; i < node.children.length; i++) {
    result.push(node.children[i]);
    result = result.concat(descendants(node.children[i]));
  }
  return result;
}

function byClass(node, className) {
  return descendants(node).filter(function (item) { return item.classList.contains(className); });
}

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function projectedProject(projectId, title, childTitle) {
  return {
    projectRef: { projectId: projectId },
    title: title,
    topics: [],
    summary: {
      coordinatorTree: [{
        sessionRef: { projectId: projectId, sessionStorageId: title.toLowerCase() + "-project-coordinator" },
        title: "Project coordinator",
        role: "project_coordinator",
        status: "queued",
        children: childTitle ? [{
          sessionRef: { projectId: projectId, sessionStorageId: title.toLowerCase() + "-task-coordinator" },
          title: childTitle,
          role: "task_coordinator",
          status: "running",
          children: [],
        }] : [],
      }],
    },
  };
}

test("shared Coop renderer places project coordinator rows in desktop and mobile global sidebars", async function () {
  globalThis.document = { createElement: createElement };
  var modelModule = await import(moduleUrl("sidebar-coop-topic-model.js") + "?v=" + Date.now());
  var renderer = await import(moduleUrl("sidebar-coop-hierarchy.js") + "?v=" + Date.now());
  var model = {
    hasProjection: true,
    projects: [
      projectedProject(CLAY, "Clay", "Show project coordinators in Coop sidebar"),
      projectedProject(WEBAPP, "Webapp", ""),
    ],
    uncategorisedTopics: [],
    crossProjectTopics: [],
  };
  var sections = modelModule.coopTopicSections(model);
  assert.deepEqual(sections.map(function (section) { return section.label; }), ["Clay", "Webapp"],
    "project roots create global Coop groups even when no topic row exists");

  var desktop = createElement("div");
  var mobile = createElement("div");
  for (var i = 0; i < sections.length; i++) {
    renderer.renderCoopProjectHierarchy(desktop, sections[i].hierarchy, {
      mobile: false, send: function () { return true; },
    });
    renderer.renderCoopProjectHierarchy(mobile, sections[i].hierarchy, {
      mobile: true, send: function () { return true; },
    });
  }

  var desktopRows = byClass(desktop, "coop-project-coordinator-row");
  var mobileRows = byClass(mobile, "mobile-coop-project-coordinator-row");
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("root"); }).length, 2);
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("child"); }).length, 1);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("root"); }).length, 2);
  assert.equal(mobileRows.filter(function (row) { return row.classList.contains("child"); }).length, 1);
  assert.equal(desktopRows.filter(function (row) { return row.classList.contains("child"); })[0]
    .children[1].textContent,
    "Show project coordinators in Coop sidebar");
});
