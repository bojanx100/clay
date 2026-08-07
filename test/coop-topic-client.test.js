var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

async function loadProjectionUi() {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js");
  return import(pathToFileURL(modulePath).href + "?topic-test=" + Date.now() + Math.random());
}

function topic(topicId, extra) {
  return Object.assign({
    topicRef: { topicId: topicId },
    title: topicId,
    status: "running",
    active: true,
    unreadCount: 2,
    rollingSummary: "Rolling summary for " + topicId,
    decisions: ["Keep the canonical path"],
    canonicalEvents: [{ eventRef: { eventId: "event-" + topicId }, title: "Decision event" }],
  }, extra || {});
}

test("topic projection normalizes project, cross-project, and uncategorised groups", async function () {
  var ui = await loadProjectionUi();
  ui.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [{
      projectRef: { projectId: "project-1" },
      slug: "clay",
      title: "Clay",
      topics: [topic("project-topic", { projectRef: { projectId: "project-1" } })],
    }],
    topics: [
      topic("cross-topic", { group: "cross_project", projectRef: null }),
      topic("uncategorised-topic", { group: "uncategorised", projectRef: null }),
    ],
  });
  var model = ui.buildGlobalCoopDisplayModel("");
  assert.deepEqual(model.projects[0].topics.map(function (item) { return item.topicRef.topicId; }), ["project-topic"]);
  assert.deepEqual(model.crossProjectTopics.map(function (item) { return item.topicRef.topicId; }), ["cross-topic"]);
  assert.deepEqual(model.uncategorisedTopics.map(function (item) { return item.topicRef.topicId; }), ["uncategorised-topic"]);
  assert.equal(model.allTopics.length, 3);
  assert.equal(model.projects[0].topics[0].rollingSummary, "Rolling summary for project-topic");
  assert.equal(model.projects[0].topics[0].decisions[0], "Keep the canonical path");
});

test("topic projection accepts the grouped server reference shape", async function () {
  var ui = await loadProjectionUi();
  ui.setGlobalCoopProjection({
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [],
    topics: [],
    topicProjection: { groups: [{
      kind: "cross_project",
      topics: [topic("grouped-topic", {
        canonicalEvents: null,
        eventRefs: [{ projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 2 }],
      })],
    }] },
  });
  var model = ui.buildGlobalCoopDisplayModel("");
  assert.equal(model.crossProjectTopics[0].topicRef.topicId, "grouped-topic");
  assert.equal(model.crossProjectTopics[0].canonicalEvents[0].eventRef.eventIndex, 2);
});

test("canonical event drill-through uses the server ProjectRef/session/event index identity", async function () {
  var ui = await loadProjectionUi();
  var projectRef = { projectId: "project-events" };
  var serverEventRef = {
    projectId: "system-lead",
    sessionStorageId: "canonical-topic-home",
    eventIndex: 12,
    eventId: "legacy-event-id",
  };
  var selected = topic("topic-server-event", {
    projectRef: projectRef,
    canonicalEvents: [{ eventRef: serverEventRef, title: "Server event" }],
  });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [selected] });
  var sent = [];
  assert.equal(ui.requestCanonicalEvent(serverEventRef, selected.topicRef, projectRef, function (message) {
    sent.push(message);
    return true;
  }), true);
  assert.deepEqual(sent[0].eventRef, serverEventRef);
  assert.equal(ui.requestCanonicalEvent({ eventId: "legacy-event-id" }, selected.topicRef, projectRef, function () {
    return true;
  }), false);
});

test("topic selection keeps the canonical Coop session and sends exact refs", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  storeModule.createStore({ activeCoopHome: false, activeSessionId: 99 });
  var projectRef = { projectId: "project-1" };
  var selected = topic("topic-1", { projectRef: projectRef });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [selected] });
  var sent = [];
  assert.equal(ui.requestCoopTopic(selected, function (message) { sent.push(message); return true; }), true);
  assert.deepEqual(sent, [
    { type: "coop_topic_select", topicRef: { topicId: "topic-1" }, projectRef: projectRef, historyScope: "topic" },
  ]);
  assert.equal(storeModule.store.get("activeCoopTopicRef"), undefined);
  assert.equal(ui.handleCoopTopicSelected({
    type: "coop_topic_selected", ok: true, topicRef: { topicId: "topic-1" }, projectRef: projectRef,
  }), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(storeModule.store.get("activeCoopTopicRef"), { topicId: "topic-1" });
  assert.deepEqual(storeModule.store.get("activeCoopProjectRef"), projectRef);
  var eventSent = [];
  assert.equal(ui.requestCanonicalEvent(
    { eventId: "event-topic-1" },
    { topicId: "topic-1" },
    projectRef,
    function (message) { eventSent.push(message); return true; }
  ), true);
  assert.deepEqual(eventSent, [{
    type: "resolve_canonical_event",
    eventRef: { eventId: "event-topic-1" },
    topicRef: { topicId: "topic-1" },
    projectRef: projectRef,
  }]);
});

test("topic selection forces a filtered replay even when canonical Coop is already active", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  var projectRef = { projectId: "project-1" };
  var selected = topic("topic-active", { projectRef: projectRef });
  storeModule.createStore({ activeCoopHome: true, activeSessionId: 7 });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [selected] });
  var sent = [];
  assert.equal(ui.requestCoopTopic(selected, function (message) { sent.push(message); return true; }), true);
  assert.deepEqual(sent[0], {
    type: "coop_topic_select", topicRef: { topicId: "topic-active" }, projectRef: projectRef, historyScope: "topic",
  });
  assert.equal(ui.handleCoopTopicSelected({ type: "coop_topic_selected", ok: true, topicRef: selected.topicRef, projectRef: projectRef }), true);
  assert.equal(sent.length, 1);
});

test("All restores the unfiltered canonical replay contract", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  storeModule.createStore({ activeCoopHome: true, activeSessionId: 7, activeCoopTopicRef: { topicId: "topic-active" } });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [] });
  var sent = [];
  assert.equal(ui.requestAllCoopTopics(function (message) { sent.push(message); return true; }), true);
  assert.equal(storeModule.store.get("activeCoopTopicRef").topicId, "topic-active");
  assert.equal(ui.handleCoopTopicSelected({ type: "coop_topic_selected", ok: true, topicRef: null, projectRef: null }), true);
  assert.deepEqual(sent, [
    { type: "coop_topic_select", topicRef: null, projectRef: null, historyScope: "canonical" },
  ]);
  assert.equal(storeModule.store.get("activeCoopTopicRef"), null);
});

test("topic selection denial leaves the prior lens and destination unchanged", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  var prior = topic("topic-prior", { projectRef: { projectId: "project-1" } });
  var selected = topic("topic-rejected", { projectRef: { projectId: "project-2" } });
  storeModule.createStore({ activeCoopHome: true, activeSessionId: 7, activeCoopTopicRef: prior.topicRef, activeCoopProjectRef: prior.projectRef });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [prior, selected] });
  var sent = [];
  assert.equal(ui.requestCoopTopic(selected, function (message) { sent.push(message); return true; }), true);
  assert.equal(ui.handleCoopTopicSelected({ type: "coop_topic_selected", ok: false, code: "topic_project_mismatch" }, function (message) {
    sent.push(message);
    return true;
  }), true);
  assert.deepEqual(storeModule.store.get("activeCoopTopicRef"), prior.topicRef);
  assert.deepEqual(storeModule.store.get("activeCoopProjectRef"), prior.projectRef);
  assert.deepEqual(sent, [{ type: "coop_topic_select", topicRef: selected.topicRef, projectRef: selected.projectRef, historyScope: "topic" }]);
});

test("browser history lenses validate before committing and restore on denial", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  var priorLocation = globalThis.location;
  var priorHistory = globalThis.history;
  var replacements = [];
  globalThis.location = { pathname: "/p/lead/", search: "?coopTopic=topic-old" };
  globalThis.history = {
    replaceState: function (_, __, value) {
      replacements.push(value);
      var parsed = new URL(value, "http://clay.test");
      globalThis.location.pathname = parsed.pathname;
      globalThis.location.search = parsed.search;
    },
    pushState: function (_, __, value) {
      var parsed = new URL(value, "http://clay.test");
      globalThis.location.pathname = parsed.pathname;
      globalThis.location.search = parsed.search;
    },
  };
  try {
    var prior = topic("topic-old");
    var selected = topic("topic-new");
    storeModule.createStore({
      activeCoopHome: true, activeSessionId: 7, activeCoopTopicRef: prior.topicRef,
      committedCoopLensUrl: "/p/lead/?coopTopic=topic-old",
    });
    ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [prior, selected] });
    globalThis.location.search = "?coopTopic=topic-new";
    var sent = [];
    assert.equal(ui.syncCoopLensFromUrl(function (message) { sent.push(message); return true; }), true);
    assert.deepEqual(storeModule.store.get("activeCoopTopicRef"), prior.topicRef);
    assert.deepEqual(sent, [{ type: "coop_topic_select", topicRef: selected.topicRef, projectRef: null, historyScope: "topic" }]);
    assert.equal(ui.handleCoopTopicSelected({ type: "coop_topic_selected", ok: false, code: "topic_closed" }), true);
    assert.deepEqual(storeModule.store.get("activeCoopTopicRef"), prior.topicRef);
    assert.equal(globalThis.location.search, "?coopTopic=topic-old");
    assert.deepEqual(replacements, ["/p/lead/?coopTopic=topic-old"]);
  } finally {
    if (priorLocation === undefined) delete globalThis.location;
    else globalThis.location = priorLocation;
    if (priorHistory === undefined) delete globalThis.history;
    else globalThis.history = priorHistory;
  }
});

test("result handlers preserve explicit server outcomes for coordinator wiring", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  storeModule.createStore({});
  assert.equal(ui.handleCoopTopicResult({ type: "coop_topic_result", operation: "rename", ok: false, code: "topic_not_found" }), true);
  assert.deepEqual(storeModule.store.get("lastCoopTopicResult"), { operation: "rename", ok: false, code: "topic_not_found", topicRefs: null });
  assert.equal(ui.handleCanonicalEventResolved({
    type: "canonical_event_resolved", ok: true, topicRef: { topicId: "topic-1" },
    eventRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 3 },
  }), true);
  assert.deepEqual(storeModule.store.get("lastCanonicalEventResolution"), {
    ok: true, code: null, topicRef: { topicId: "topic-1" },
    eventRef: { projectId: "system-lead", sessionStorageId: "coop-home", eventIndex: 3 }, turnRef: null,
  });
});

test("topic drill-through rejects events absent from the server projection", async function () {
  var ui = await loadProjectionUi();
  var projectRef = { projectId: "project-1" };
  var selected = topic("topic-drill", { projectRef: projectRef });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [selected] });
  var sent = [];
  assert.equal(ui.requestCanonicalEvent({ eventId: "not-in-topic" }, selected.topicRef, projectRef, function (message) {
    sent.push(message);
    return true;
  }), false);
  assert.deepEqual(sent, []);
});

test("durable topic actions use explicit WS types and exact references", async function () {
  var topicRef = { topicId: "topic-actions" };
  var projectRef = { projectId: "project-actions" };
  var selected = topic("topic-actions", { projectRef: projectRef });
  var model = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topic-model.js")).href + "?action-test=" + Date.now() + Math.random());
  var cases = [
    ["rename", selected, { title: "Renamed" }, { type: "coop_topic_rename", topicRef: topicRef, projectRef: projectRef, title: "Renamed" }],
    ["move", selected, { targetProjectRef: { projectId: "target-project" } }, { type: "coop_topic_move", topicRef: topicRef, projectRef: projectRef, targetProjectRef: { projectId: "target-project" } }],
    ["merge", selected, { targetTopicRef: { topicId: "target-topic" } }, { type: "coop_topic_merge", topicRef: topicRef, projectRef: projectRef, targetTopicRef: { topicId: "target-topic" } }],
    ["split", selected, { title: "Split" }, { type: "coop_topic_split", topicRef: topicRef, projectRef: projectRef, title: "Split" }],
    ["close", selected, {}, { type: "coop_topic_close", topicRef: topicRef, projectRef: projectRef }],
    ["reopen", selected, {}, { type: "coop_topic_reopen", topicRef: topicRef, projectRef: projectRef }],
  ];
  for (var i = 0; i < cases.length; i++) {
    assert.deepEqual(model.buildCoopTopicActionMessage(cases[i][0], cases[i][1], cases[i][2]), cases[i][3], cases[i][0]);
  }
});

test("topic URL history and stale selection fail closed", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  assert.equal(ui.projectLensPath("/p/lead/", "?keep=1", { projectId: "p1" }, { topicId: "t1" }), "/p/lead/?keep=1&coopProject=p1&coopTopic=t1");
  storeModule.createStore({ activeCoopHome: true, activeCoopTopicRef: { topicId: "removed" } });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [], topics: [] });
  assert.equal(ui.isActiveCoopTopicStale(), true);
  assert.equal(ui.getActiveCoopSelection(), null);
});

test("project lenses retain ProjectRef-only composer routing", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  var projectRef = { projectId: "project-lens" };
  storeModule.createStore({ activeCoopHome: true, activeCoopLens: { projectRef: projectRef } });
  assert.deepEqual(ui.getActiveCoopIngressRefs(), { topicRef: null, projectRef: projectRef });
});

test("project lenses validate and replay canonically before changing the destination", async function () {
  var ui = await loadProjectionUi();
  var storeModule = await import(pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "store.js")).href);
  var projectRef = { projectId: "project-lens" };
  var project = {
    projectRef: projectRef, slug: "lens", title: "Lens project",
    channel: { localId: 7, isLens: true }, summary: {},
  };
  storeModule.createStore({ activeCoopHome: true, activeSessionId: 7 });
  ui.setGlobalCoopProjection({ type: "global_coop_projection", coop: { localId: 7 }, projects: [project], topics: [] });
  var sent = [];
  assert.equal(ui.requestProjectChannel(project, function (message) { sent.push(message); return true; }), true);
  assert.deepEqual(sent, [{ type: "coop_topic_select", topicRef: null, projectRef: projectRef, historyScope: "canonical" }]);
  assert.equal(storeModule.store.get("activeCoopProjectRef"), undefined);
  assert.equal(ui.handleCoopTopicSelected({ type: "coop_topic_selected", ok: true, topicRef: null, projectRef: projectRef }), true);
  assert.deepEqual(storeModule.store.get("activeCoopProjectRef"), projectRef);
  assert.deepEqual(ui.getActiveCoopIngressRefs(), { topicRef: null, projectRef: projectRef });
});

test("Coop navigation renders only compact topic chat rows", function () {
  var desktop = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"), "utf8");
  var mobile = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"), "utf8");
  var topics = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topics.js"), "utf8");
  var topicModel = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "sidebar-coop-topic-model.js"), "utf8");
  var desktopCss = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"), "utf8");
  var mobileCss = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"), "utf8");
  var projection = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "global-coop-projection.js"), "utf8");
  var input = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "input.js"), "utf8");
  var stt = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "stt.js"), "utf8");
  assert.match(desktop, /renderCoopTopicSections/);
  assert.match(mobile, /renderCoopTopicSections/);
  assert.doesNotMatch(desktop, /New topic|coop-topic-create|coop_topic_create/);
  assert.doesNotMatch(mobile, /New topic|coop-topic-create|coop_topic_create/);
  assert.doesNotMatch(topics, /New topic|coop-topic-create|coop_topic_create/);
  assert.doesNotMatch(topicModel, /coop_topic_create/);
  assert.doesNotMatch(desktopCss, /coop-topic-create/);
  assert.doesNotMatch(mobileCss, /coop-topic-create/);
  assert.match(topics, /topicActivity\(topic\)/);
  assert.match(topics, /topic\.unread > 0/);
  assert.match(topics, /requestCoopTopic\(topic, sendUserAction\).*finishNavigation\(options\)/s);
  assert.match(topics, /requestAllCoopTopics\(sendUserAction\).*finishNavigation\(opts\)/s);
  assert.match(mobile, /onNavigate: finishMobileCoopNavigation/);
  assert.match(mobile, /if \(getCachedCurrentSlug\(\) === "lead"\) \{\s+renderMobileSessionsInto\(listEl\);/);
  assert.doesNotMatch(desktop, /Goals|Decisions|Active work|Verified outcomes|Open canonical project|appendProjectedSessionTree/);
  assert.doesNotMatch(mobile, /Goals|Decisions|Active work|Verified outcomes|Open canonical project|appendMobileProjectedSessionTree/);
  assert.doesNotMatch(topics, /coop-topic-details|coop-topic-drawer|coop-topic-event|coop-topic-actions|openTopicDialog/);
  assert.doesNotMatch(desktopCss, /coop-topic-details|coop-topic-drawer|coop-topic-event|coop-topic-actions/);
  assert.doesNotMatch(mobileCss, /mobile-coop-topic-details|mobile-coop-topic-drawer|mobile-coop-topic-event|mobile-coop-topic-actions/);
  assert.match(projection, /from '\.\/sidebar-coop-topic-model\.js'/);
  assert.doesNotMatch(projection, /function cloneTopic\(/);
  assert.match(projection, /resolve_canonical_event/);
  assert.match(projection, /beginCoopSelection\(selected\.topicRef, selected\.projectRef, "topic"/);
  assert.match(projection, /beginCoopSelection\(null, null, "canonical"/);
  assert.match(projection, /handleCoopTopicSelected/);
  assert.match(projection, /handleCoopTopicResult/);
  assert.match(projection, /handleCanonicalEventResolved/);
  assert.match(topicModel, /buildCoopTopicActionMessage/);
  assert.match(topics, /showHeading: false/);
  assert.match(input, /coopTopicRef/);
  assert.match(input, /coopProjectRef/);
  assert.match(input, /isActiveCoopTopicStale/);
  assert.match(stt, /getSTTCoopRouting/);
});
