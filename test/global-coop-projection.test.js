var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;
var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;

function session(id, value) {
  return Object.assign({
    localId: id,
    storageId: "session-" + id,
    title: "Session " + id,
    lastActivity: 10,
  }, value || {});
}

function project(projectId, slug, sessions, extra) {
  var manager = {
    sessions: new Map(sessions.map(function (item) { return [item.localId, item]; })),
    saveSessionFile: function () {},
    createSessionRaw: function (options) {
      var created = session(this.sessions.size + 100, options);
      this.sessions.set(created.localId, created);
      return created;
    },
  };
  return Object.assign({
    projectId: projectId,
    slug: slug,
    title: slug,
    sm: manager,
  }, extra || {});
}

test("Coop projects each accessible configured project into a main-lane lens with canonical nested sessions", function () {
  var home = session(1, { storageId: "coop-home", coopHome: true });
  var lead = project("system-lead", "lead", [home], { isLead: true });
  var task = {
    taskId: "active-work",
    title: "Fix project switch",
    objective: "Keep project navigation isolated",
    status: "running",
    currentActivity: "Adding target-keyed cache",
    updatedAt: 20,
  };
  var coordinator = session(10, {
    coordinationMode: true,
    orchestrationTasks: [task],
    orchestrationProjectCompletion: {
      status: "completed",
      summary: "Earlier verified release",
      completedAt: 15,
    },
  });
  var directOwnerSession = session(11, { title: "Owner direct conversation" });
  var worker = session(12, {
    title: "Canonical worker",
    orchestrationParent: { sessionStorageId: coordinator.storageId, taskId: task.taskId },
  });
  var clay = project("11111111-1111-5111-8111-111111111111", "clay", [coordinator, directOwnerSession, worker], { title: "Clay" });
  var worktree = project("22222222-2222-5222-8222-222222222222", "clay--feature", [], { isWorktree: true });
  var mate = project("33333333-3333-5333-8333-333333333333", "mate-ada", [], { isMate: true });

  var projection = buildGlobalCoopProjection({ projects: [lead, clay, worktree, mate] });

  assert.equal(projection.coop.sessionRef.projectId, "system-lead");
  assert.equal(projection.projects.length, 1);
  var channel = projection.projects[0];
  assert.deepEqual(channel.projectRef, { projectId: clay.projectId });
  assert.equal(channel.channel.sessionRef.projectId, "system-lead");
  assert.equal(channel.channel.sessionRef.sessionStorageId, "coop-home");
  assert.equal(channel.channel.isLens, true);
  assert.equal(channel.summary.goals[0], "Keep project navigation isolated");
  assert.equal(channel.summary.activeWork[0].title, "Fix project switch");
  assert.equal(channel.summary.outcomes[0].summary, "Earlier verified release");
  assert.match(channel.summary.nextAction, /active delegated work/);
  assert.equal(Object.hasOwn(channel, "coordinators"), false);
  assert.equal(Object.hasOwn(channel, "directLeaves"), false);
  assert.equal(JSON.stringify(channel).includes("Owner direct conversation"), false);
  assert.equal(channel.summary.metrics.activeCoordinators, 1);
  assert.equal(channel.summary.metrics.activeWorkers, 1);
  assert.equal(channel.summary.coordinatorTree[0].sessionRef.projectId, clay.projectId);
  assert.equal(channel.summary.coordinatorTree[0].children[0].sessionRef.sessionStorageId, worker.storageId);

  var second = buildGlobalCoopProjection({ projects: [lead, clay] });
  assert.equal(second.projects[0].channel.sessionRef.sessionStorageId,
    channel.channel.sessionRef.sessionStorageId);
});

test("Coop summary applies project ACLs and summarizes attention without exposing attempts", function () {
  var lead = project("system-lead", "lead", [session(1, { storageId: "coop-home", coopHome: true })], { isLead: true });
  var blocked = session(2, {
    coordinationMode: true,
    orchestrationTasks: [{
      taskId: "needs-owner",
      title: "Choose owner",
      status: "needs_input",
      userQuestion: "Which owner should approve this?",
      workerStorageId: "hidden-worker",
      attempt: 3,
    }],
  });
  var visible = project("44444444-4444-5444-8444-444444444444", "visible", [blocked]);
  var denied = project("55555555-5555-5555-8555-555555555555", "denied", []);
  var projection = buildGlobalCoopProjection({
    projects: [lead, visible, denied],
    canAccessProject: function (_, item) { return item !== denied; },
  });

  assert.deepEqual(projection.projects.map(function (item) { return item.slug; }), ["visible"]);
  assert.equal(projection.projects[0].summary.attention[0].title, "Choose owner");
  assert.match(projection.projects[0].summary.nextAction, /resolve attention/);
  assert.equal(JSON.stringify(projection.projects[0]).includes("hidden-worker"), false);
  assert.equal(JSON.stringify(projection.projects[0]).includes("attempt"), false);
});

test("global Coop projection exposes bounded topic lenses and revokes denied project topics", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-global-topic-"));
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = session(1, {
      storageId: "canonical-topic-home", coopHome: true,
      history: [
        { type: "user_message", text: "Navigation session restoration and sidebar" },
        { type: "delta_replace", text: "The navigation restoration is complete." },
        { type: "done" },
      ],
    });
    var lead = project("system-lead", "lead", [home], { isLead: true });
    var clay = project("5332aafc-31e7-5cb1-ba96-c8d90e78260e", "clay", []);
    buildGlobalCoopProjection({ projects: [lead, clay], coopTopicIndex: index });
    assert.equal(index.addEventMembership({ topicId: "navigation-session-restoration" }, [
      { eventIndex: 1 }, { eventIndex: 2 },
    ]).ok, true);
    var durableNavigation = index.resolve({ topicId: "navigation-session-restoration" }).topic;
    for (var eventIndex = 3; eventIndex < 21000; eventIndex++) {
      durableNavigation.eventRefs.push({
        projectId: "system-lead", sessionStorageId: "canonical-topic-home", eventIndex: eventIndex,
      });
    }
    var visible = buildGlobalCoopProjection({ projects: [lead, clay], coopTopicIndex: index });
    var navigation = visible.topics.find(function (topic) { return topic.topicRef.topicId === "navigation-session-restoration"; });
    assert.equal(navigation.projectRef.projectId, clay.projectId);
    assert.equal(navigation.group, "project");
    assert.deepEqual(navigation.canonicalEvents[0].eventRef, {
      eventKey: "canonical:canonical-topic-home:0", projectId: "system-lead",
      sessionStorageId: "canonical-topic-home", eventIndex: 0,
    });
    assert.equal(navigation.eventCount, 21000);
    assert.equal(navigation.turnCount, 1);
    assert.equal(navigation.canonicalEvents.length, 2);
    assert.equal(navigation.lastEventRef.eventIndex, 20999);
    assert.equal(Object.hasOwn(navigation, "canonicalTurnRanges"), false);
    assert.equal(navigation.status, "open");
    assert.equal(navigation.rollingSummary, "1 canonical turn");
    assert.equal(JSON.stringify(navigation).includes("Navigation session restoration and sidebar"), false);
    assert.equal(index.resolve({ topicId: "navigation-session-restoration" }).topic.eventRefs.length, 21000,
      "full membership remains in the server-side durable index");
    var rawTopic = visible.topicProjection.groups.reduce(function (found, group) {
      return found || group.topics.find(function (topic) { return topic.topicRef.topicId === "navigation-session-restoration"; });
    }, null);
    assert.equal(Object.hasOwn(rawTopic, "eventRefs"), true);
    assert.deepEqual(rawTopic.eventRefs, []);
    assert.deepEqual(rawTopic.turnRefs, []);
    assert.equal(JSON.stringify(visible).length < 20000, true,
      "a 21k-event topic does not inflate the initial sidebar projection");
    assert.equal(JSON.stringify(visible).includes('"eventIndex":10000'), false,
      "non-preview canonical memberships stay server-side");

    var revoked = buildGlobalCoopProjection({
      projects: [lead, clay], coopTopicIndex: index,
      canAccessProject: function (_, item) { return item !== clay; },
    });
    assert.equal(revoked.topics.some(function (topic) { return topic.projectRef && topic.projectRef.projectId === clay.projectId; }), false);

    var deniedCanonical = buildGlobalCoopProjection({
      projects: [lead, clay], coopTopicIndex: index,
      canAccessSession: function () { return false; },
    });
    assert.deepEqual(deniedCanonical.topics, []);
    assert.equal(deniedCanonical.topicProjection, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
