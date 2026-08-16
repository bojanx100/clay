var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP = "11111111-1111-5111-8111-111111111111";

// A minimal DOM. The close control and the links expander build nodes
// imperatively, so exercising the real render path is the only way to prove the
// collapsed default, the ARIA wiring, and the confirmation gate.
function createElement(tag) {
  var node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    listeners: {},
    className: "",
    id: "",
    type: "",
    _text: "",
    parentNode: null,
  };
  Object.defineProperty(node, "textContent", {
    get: function () {
      if (node.children.length === 0) return node._text;
      return node.children.map(function (child) { return child.textContent; }).join("");
    },
    set: function (value) { node._text = String(value); node.children = []; },
  });
  node.classList = {
    add: function (name) { if (!node.classList.contains(name)) node.className = (node.className + " " + name).trim(); },
    contains: function (name) { return node.className.split(/\s+/).indexOf(name) !== -1; },
  };
  node.setAttribute = function (name, value) { node.attributes[name] = String(value); };
  node.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
  };
  node.hidden = false;
  node.appendChild = function (child) {
    child.parentNode = node;
    node.children.push(child);
    return child;
  };
  node.removeChild = function (child) {
    var index = node.children.indexOf(child);
    if (index !== -1) node.children.splice(index, 1);
    child.parentNode = null;
    return child;
  };
  node.addEventListener = function (type, handler) {
    node.listeners[type] = (node.listeners[type] || []).concat(handler);
  };
  node.click = function () {
    var handlers = node.listeners.click || [];
    for (var i = 0; i < handlers.length; i++) handlers[i]({ target: node, currentTarget: node,
      stopPropagation: function () {}, preventDefault: function () {} });
  };
  node.focus = function () { if (globalThis.document) globalThis.document.activeElement = node; };
  node.querySelectorAll = function (selector) {
    if (selector !== "button:not([disabled])") return [];
    return descendants(node).filter(function (item) { return item.tagName === "BUTTON" && !item.disabled; });
  };
  node.querySelector = function (selector) {
    if (selector !== "button") return null;
    return descendants(node).filter(function (item) { return item.tagName === "BUTTON"; })[0] || null;
  };
  return node;
}

function descendants(node) {
  var all = [];
  for (var i = 0; i < node.children.length; i++) {
    all.push(node.children[i]);
    all = all.concat(descendants(node.children[i]));
  }
  return all;
}

function byClass(node, className) {
  return descendants(node).filter(function (item) { return item.classList.contains(className); });
}

function modulePath(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function source(name) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", name), "utf8");
}

// Loads only the modules that are independent of the app connection graph:
// the pure topic model, the ACL-shaped projection, and the two topic controls.
// Loaded without cache-busting so the controls and this test share one
// projection module instance -- the controls resolve topics through it. Per-test
// isolation comes from createStore plus a fresh setGlobalCoopProjection call.
async function loadTopicControls() {
  var body = createElement("body");
  globalThis.document = { createElement: createElement, getElementById: function () { return null; },
    body: body, activeElement: null };
  var storeModule = await import(modulePath("store.js"));
  storeModule.createStore({ activeCoopHome: true, currentSlug: "lead" });
  return {
    store: storeModule.store,
    model: await import(modulePath("sidebar-coop-topic-model.js")),
    projection: await import(modulePath("global-coop-projection.js")),
    close: await import(modulePath("sidebar-coop-topic-close.js")),
    links: await import(modulePath("sidebar-coop-topic-links.js")),
  };
}

function topic(topicId, extra) {
  return Object.assign({
    topicRef: { topicId: topicId },
    title: "Topic " + topicId,
    status: "open",
    active: true,
  }, extra || {});
}

function projectionMessage(overrides) {
  return Object.assign({
    type: "global_coop_projection",
    coop: { localId: 7 },
    projects: [],
    topics: [],
  }, overrides || {});
}

function sectionShape(sections) {
  return sections.map(function (section) { return section.kind + ":" + section.label; });
}

// --- Ordering and empty categories (pure model) ---

test("all open topics render in one Threads group without legacy categories", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [
      { projectRef: { projectId: CLAY }, slug: "clay", title: "clay", icon: "C",
        summary: { coordinatorTree: [{ sessionRef: { projectId: "system-lead", sessionStorageId: "clay-coordinator" },
          title: "Project coordinator", role: "project_coordinator", children: [{
            sessionRef: { projectId: CLAY, sessionStorageId: "clay-task-coordinator" },
            title: "Active Clay work", role: "task_coordinator", status: "running", children: [],
          }] }] },
        topics: [topic("clay-one", { projectRef: { projectId: CLAY } })] },
      { projectRef: { projectId: WEBAPP }, slug: "webapp", title: "webapp",
        summary: { coordinatorTree: [{ sessionRef: { projectId: "system-lead", sessionStorageId: "webapp-coordinator" },
          title: "webapp coordinator", role: "project_coordinator", children: [] }] }, topics: [] },
    ],
    topics: [topic("cross-one", { group: "cross_project" }), topic("uncat-one", { group: "uncategorised" })],
    controlPlaneSessions: [
      { role: "council", title: "Council", sessionRef: { projectId: "system-lead", sessionStorageId: "council" } },
      { role: "triage", title: "Triage", sessionRef: { projectId: "system-lead", sessionStorageId: "triage" } },
    ],
  }));
  var sections = ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""));
  assert.deepEqual(sectionShape(sections), ["threads:Threads",
    "project_coordinators:Project coordinators", "council:Council", "triage:Triage"]);
  assert.deepEqual(sections[0].topics.map(function (item) { return item.topicRef.topicId; }),
    ["clay-one", "cross-one", "uncat-one"]);
  assert.deepEqual(sections[1].coordinators.map(function (item) {
    return item.hierarchy[0].title;
  }), ["Clay coordinator"]);
});

test("a project-classified open topic still lives in Threads", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [topic("clay-one", { projectRef: { projectId: CLAY } })] }],
    topics: [],
  }));
  assert.deepEqual(
    sectionShape(ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""))),
    ["threads:Threads"]
  );
});

test("all empty Coop control groups are omitted without headings or placeholders", async function () {
  var ui = await loadTopicControls();
  assert.deepEqual(sectionShape(ui.model.coopTopicSections({})), []);
  assert.deepEqual(sectionShape(ui.model.coopTopicSections(null)), []);
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [] }],
    topics: [],
  }));
  assert.deepEqual(sectionShape(ui.model.coopTopicSections(
    ui.projection.buildGlobalCoopDisplayModel(""))), []);
});

test("project coordinators omit empty and terminal-only history but retain active and attention work", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{
      projectRef: { projectId: "empty" }, title: "Empty", summary: { coordinatorTree: [{
        sessionRef: { projectId: "system-lead", sessionStorageId: "empty-coordinator" },
        title: "Empty coordinator", role: "project_coordinator", children: [],
      }] },
    }, {
      projectRef: { projectId: "terminal" }, title: "Terminal", summary: { coordinatorTree: [{
        sessionRef: { projectId: "system-lead", sessionStorageId: "terminal-coordinator" },
        title: "Terminal coordinator", role: "project_coordinator", children: [{
          topicRef: { topicId: "handed-off-history" }, title: "Handed-off history", role: "thread",
          status: "handed_off", children: [],
        }, {
          topicRef: { topicId: "completed-history" }, title: "Completed history", role: "thread",
          status: "completed", children: [],
        }],
      }] },
    }, {
      projectRef: { projectId: "active" }, title: "Active", summary: { coordinatorTree: [{
        sessionRef: { projectId: "system-lead", sessionStorageId: "active-coordinator" },
        title: "Active coordinator", role: "project_coordinator", children: [{
          sessionRef: { projectId: "active", sessionStorageId: "active-task" },
          title: "Active task", role: "task_coordinator", status: "running", children: [],
        }],
      }] },
    }, {
      projectRef: { projectId: "attention" }, title: "Attention", summary: { coordinatorTree: [{
        sessionRef: { projectId: "system-lead", sessionStorageId: "attention-coordinator" },
        title: "Attention coordinator", role: "project_coordinator", children: [{
          topicRef: { topicId: "attention-thread" }, title: "Attention Thread", role: "thread",
          status: "handed_off", children: [{
            sessionRef: { projectId: "attention", sessionStorageId: "attention-task" },
            title: "Blocked task", role: "task_coordinator", status: "needs_input", children: [],
          }],
        }],
      }] },
    }],
  }));

  var sections = ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""));
  assert.deepEqual(sectionShape(sections), ["project_coordinators:Project coordinators"]);
  assert.deepEqual(sections[0].coordinators.map(function (coordinator) {
    return coordinator.label;
  }), ["Active", "Attention"]);
  assert.equal(JSON.stringify(sections).includes("Handed-off history"), false);
  assert.equal(JSON.stringify(sections).includes("Completed history"), false);
});

test("each Coop control group can appear alone and invalid control sessions stay hidden", async function () {
  var ui = await loadTopicControls();
  var threadOnly = ui.model.coopTopicSections({ allTopics: [topic("only-thread")] });
  assert.deepEqual(sectionShape(threadOnly), ["threads:Threads"]);

  var coordinatorOnly = ui.model.coopTopicSections({
    projects: [{ title: "Clay", summary: { coordinatorTree: [{
      title: "Clay coordinator", role: "project_coordinator",
      sessionRef: { projectId: "system-lead", sessionStorageId: "clay-coordinator" },
      children: [{
        title: "Active task", role: "task_coordinator", status: "running",
        sessionRef: { projectId: CLAY, sessionStorageId: "clay-task-coordinator" }, children: [],
      }],
    }] } }],
  });
  assert.deepEqual(sectionShape(coordinatorOnly), ["project_coordinators:Project coordinators"]);

  var councilOnly = ui.model.coopTopicSections({ controlPlaneSessions: [
    { role: "council", title: "Council", sessionRef: {
      projectId: "system-lead", sessionStorageId: "council",
    } },
    { role: "triage", title: "Hidden Triage" },
    { role: "unknown", title: "Unknown", sessionRef: {
      projectId: "system-lead", sessionStorageId: "unknown",
    } },
  ] });
  assert.deepEqual(sectionShape(councilOnly), ["council:Council"]);

  ui.projection.setGlobalCoopProjection(projectionMessage({ controlPlaneSessions: [
    { role: "council", title: "Council stale", status: "idle", sessionRef: {
      projectId: "system-lead", sessionStorageId: "council",
    } },
    { role: "council", title: "Council current", status: "running", processing: true,
      sessionRef: { projectId: "system-lead", sessionStorageId: "council" } },
  ] }));
  var normalizedCouncil = ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""));
  assert.equal(normalizedCouncil[0].sessions.length, 1,
    "duplicate control-plane records normalize to one stable session row");
  assert.equal(normalizedCouncil[0].sessions[0].status, "running");

  var triageOnly = ui.model.coopTopicSections({ controlPlaneSessions: [{
    role: "triage", title: "Triage", sessionRef: {
      projectId: "system-lead", sessionStorageId: "triage",
    },
  }] });
  assert.deepEqual(sectionShape(triageOnly), ["triage:Triage"]);
});

test("search filtering can empty a category and it then renders no wrapper", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [topic("clay-one", { projectRef: { projectId: CLAY }, title: "Sidebar work" })] }],
    topics: [topic("uncat-one", { group: "uncategorised", title: "Unrelated" })],
  }));
  var filtered = ui.projection.buildGlobalCoopDisplayModel("sidebar");
  assert.deepEqual(sectionShape(ui.model.coopTopicSections(filtered)), ["threads:Threads"]);
});

test("both surfaces read section order from the one shared model function", function () {
  var topics = source("sidebar-coop-topics.js");
  var desktop = source("sidebar-sessions.js");
  var mobile = source("sidebar-mobile.js");
  assert.match(topics, /coopTopicSections\(model\)/);
  // Neither surface may order or filter categories on its own.
  assert.doesNotMatch(desktop, /uncategorisedTopics|crossProjectTopics/);
  assert.doesNotMatch(mobile, /uncategorisedTopics|crossProjectTopics/);
  assert.match(desktop, /renderCoopTopicSections/);
  assert.match(mobile, /renderCoopTopicSections/);
});

test("desktop and mobile omit Now and expose execution through the project hierarchy", function () {
  var topics = source("sidebar-coop-topics.js");
  var desktop = source("sidebar-sessions.js");
  var mobile = source("sidebar-mobile.js");
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"), "utf8");

  assert.match(topics, /renderCoopNowIndex/);
  assert.match(topics, /entries: \[\]/,
    "the shared desktop/mobile boundary must suppress every legacy Now entry");
  assert.doesNotMatch(topics, /owner-request|OwnerRequest|Unanswered/);
  assert.doesNotMatch(desktop, /ownerRequestPanelSignature|coop-owner-request/);
  assert.doesNotMatch(mobile, /coop-owner-request/);
  assert.doesNotMatch(css, /coop-owner-request|coop-owner-requests/);
});

test("admitted work leaves Threads while unadmitted discussion remains", async function () {
  var ui = await loadTopicControls();
  var coordinatorRef = { projectId: CLAY, sessionStorageId: "clay-project-coordinator" };
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{
      projectRef: { projectId: CLAY }, slug: "clay", title: "Clay",
      summary: {
        coordinatorTree: [{
          sessionRef: coordinatorRef,
          title: "Project coordinator",
          role: "project_coordinator",
          status: "running",
          children: [{
            sessionRef: { projectId: CLAY, sessionStorageId: "clay-task-coordinator" },
            title: "Active Clay task", role: "task_coordinator", status: "running", children: [],
          }],
        }],
      },
      topics: [
        topic("intake", { projectRef: { projectId: CLAY }, workState: "needs_input", stateSource: "unlinked_default" }),
        topic("working", { projectRef: { projectId: CLAY }, threadState: "handed_off", workState: "working", stateSource: "task_working" }),
        topic("attention", { projectRef: { projectId: CLAY }, threadState: "handed_off", workState: "needs_input", stateSource: "task_attention" }),
        topic("accepted", { projectRef: { projectId: CLAY }, threadState: "handed_off", workState: "done", stateSource: "task_accepted" }),
        topic("legacy-linked", {
          projectRef: { projectId: CLAY }, threadState: "handed_off", workState: "needs_input", stateSource: "unlinked_default",
          relatedSessions: [{ sessionRef: coordinatorRef, projectRef: { projectId: CLAY }, title: "Project coordinator" }],
        }),
      ],
    }],
    topics: [
      topic("foreground-intake", { group: "uncategorised", workState: "working", stateSource: "foreground" }),
      topic("cross-admitted", { group: "cross_project", threadState: "handed_off", workState: "done", stateSource: "execution_completed" }),
    ],
  }));

  var sections = ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""));
  assert.deepEqual(sectionShape(sections), ["threads:Threads",
    "project_coordinators:Project coordinators"]);
  assert.deepEqual(sections[0].topics.map(function (item) { return item.topicRef.topicId; }),
    ["intake", "foreground-intake"]);
  assert.equal(sections[1].coordinators[0].hierarchy.length, 1,
    "the persistent coordinator stays visible");
  assert.equal(sections.some(function (section) { return section.kind === "done"; }), false,
    "admitted completed work does not reappear as a duplicate Done topic");
});

test("Exploring and Parked remain in Threads while Handed off and Closed are omitted", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [
      topic("exploring", { projectRef: { projectId: CLAY }, threadState: "exploring" }),
      topic("parked", { projectRef: { projectId: CLAY }, threadState: "parked" }),
      topic("handed-off", { projectRef: { projectId: CLAY }, threadState: "handed_off" }),
      topic("closed", { projectRef: { projectId: CLAY }, threadState: "closed",
        status: "closed", closeOutcome: "not_pursuing" }),
    ] }],
  }));
  var sections = ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""));
  assert.deepEqual(sectionShape(sections), ["threads:Threads"]);
  assert.deepEqual(sections[0].topics.map(function (item) { return item.topicRef.topicId; }),
    ["exploring", "parked"]);
  assert.equal(JSON.stringify(sections).indexOf("handed-off"), -1,
    "Handed-off execution appears only beneath the persistent project coordinator");
});

test("the shared mobile DOM renders every active membership and keeps Parked as lifecycle context", async function () {
  var ui = await loadTopicControls();
  var rowModule = await import(modulePath("sidebar-coop-topic-row.js"));
  ui.store.set({ coopConversationState: {
    activeThreadRefs: [{ threadId: "exploring" }, { threadId: "parked" }],
    queuedThreadRefs: [],
  } });
  var container = createElement("div");
  var exploring = rowModule.createCoopTopicRow(topic("exploring", {
    threadRef: { threadId: "exploring" }, threadState: "exploring",
  }), { mobile: true, send: function () { return true; } });
  var parked = rowModule.createCoopTopicRow(topic("parked", {
    threadRef: { threadId: "parked" }, threadState: "parked",
  }), { mobile: true, send: function () { return true; } });
  container.appendChild(exploring);
  container.appendChild(parked);

  assert.equal(byClass(container, "mobile-coop-topic-status-working").length, 2,
    "one foreground ingress can pulse every exact Thread membership");
  assert.equal(byClass(parked, "mobile-coop-topic-state-label")[0].textContent, "Working");
  assert.match(byClass(parked, "mobile-coop-topic-row")[0].getAttribute("aria-label"),
    /Working, Parked/);
  assert.equal(parked.classList.contains("foreground-working"), true);
});

test("closed records leave navigation and an open payload returns to Threads", async function () {
  var ui = await loadTopicControls();
  function payload(status, threadState, closeOutcome) {
    return projectionMessage({
      projects: [{
        projectRef: { projectId: CLAY }, slug: "clay", title: "Clay",
        topics: [topic("close-refresh", {
          projectRef: { projectId: CLAY }, title: "Close refresh",
          status: status, threadState: threadState, closeOutcome: closeOutcome,
          workState: "needs_input", stateSource: "unlinked_default",
          eventRefs: [{ sessionStorageId: "s", eventIndex: 3 }],
        })],
      }],
    });
  }
  ui.projection.setGlobalCoopProjection(payload("open", "exploring", null));
  assert.deepEqual(sectionShape(ui.model.coopTopicSections(
    ui.projection.buildGlobalCoopDisplayModel(""))), ["threads:Threads"]);

  // Closed provenance remains durable server-side but has no navigation group.
  ui.projection.setGlobalCoopProjection(payload("closed", "closed", "implemented_resolved"));
  var closedModel = ui.projection.buildGlobalCoopDisplayModel("");
  var closedSections = ui.model.coopTopicSections(closedModel);
  assert.deepEqual(sectionShape(closedSections), []);

  // The post-reopen payload restores the topic to its open section with its
  // membership intact: nothing about the history was lost in the round trip.
  ui.projection.setGlobalCoopProjection(payload("open", "exploring", null));
  var reopened = ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""));
  assert.deepEqual(sectionShape(reopened), ["threads:Threads"]);
  assert.equal(reopened[0].topics[0].title, "Close refresh");

  // An open row offers the explicit-outcome Close dialog.
  var openMenu = ui.close.createTopicMenu(reopened[0].topics[0], { send: function () { return true; } });
  assert.equal(byClass(openMenu, "coop-topic-menu-item")[0].textContent, "Do not implement…");
  assert.doesNotMatch(source("coop-thread-controls.js"), /Implemented \/ resolved/);
  assert.match(source("coop-thread-controls.js"), /Do not implement/);

  var messages = source("app-messages-sessions.js");
  var handler = messages.slice(messages.indexOf("function handleGlobalCoopProjection"));
  handler = handler.slice(0, handler.indexOf("\nfunction ", 1));
  assert.match(handler, /setGlobalCoopProjection\(msg, sendCoopTopicMessage\)/);
  assert.match(handler, /renderSessionList\(null\)/);
  assert.match(source("sidebar-sessions.js"), /if \(refreshMobileChatSheet\) refreshMobileChatSheet\(\)/);
});

// --- Close action ---

test("cancelling Close is a strict no-op and choosing an outcome closes exactly once", async function () {
  var ui = await loadTopicControls();
  var selected = topic("close-me", { projectRef: { projectId: CLAY }, title: "Closable topic" });
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [selected] }],
  }));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];

  var sent = [];
  function send(message) { sent.push(message); return true; }

  assert.equal(ui.close.requestTopicClose(known, { send: send }), true);
  assert.equal(sent.length, 0);
  var firstDialog = byClass(document.body, "coop-thread-dialog")[0];
  var firstButtons = byClass(firstDialog, "coop-thread-dialog-button");
  assert.deepEqual(firstButtons.map(function (button) { return button.textContent; }),
    ["Do not implement", "Cancel"]);
  firstButtons[1].click();
  assert.equal(sent.length, 0, "Cancel does not mutate durable state");

  assert.equal(ui.close.requestTopicClose(known, { send: send }), true);
  var secondDialog = byClass(document.body, "coop-thread-dialog")[0];
  var discard = byClass(secondDialog, "coop-thread-dialog-button")[0];
  discard.click();
  discard.click();
  assert.equal(sent.length, 1, "a repeated confirmation must not close twice");
  assert.deepEqual(sent[0], {
    type: "coop_thread_state", state: "closed", closeOutcome: "not_pursuing",
    topicRef: { topicId: "close-me" },
    threadRef: { threadId: "close-me" },
  });
});

test("Close re-resolves on confirm so a topic merged meanwhile is not resurrected", async function () {
  var ui = await loadTopicControls();
  var selected = topic("merge-me", { projectRef: { projectId: CLAY }, title: "Mergeable topic" });
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [selected] }],
  }));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];

  var sent = [];
  assert.equal(ui.close.requestTopicClose(known, {
    send: function (message) { sent.push(message); return true; },
  }), true);
  var pending = byClass(document.body, "coop-thread-dialog-button")[0];

  // While the modal is open the topic is merged away, so a refreshed projection
  // no longer contains it. Closing the captured copy would re-add it as closed.
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [] }],
  }));
  pending.click();
  assert.equal(sent.length, 0, "a topic that vanished mid-confirmation is not closed");
});

test("Close refuses to act on a topic that is no longer in the projection", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({}));
  var sent = [];
  var confirmed = 0;
  assert.equal(ui.close.requestTopicClose(topic("vanished"), {
    confirm: function () { confirmed++; },
    send: function (message) { sent.push(message); return true; },
  }), false);
  assert.equal(confirmed, 0, "no confirmation is offered for an unresolvable topic");
  assert.equal(sent.length, 0);
});

test("Close fails closed when no transport is available", async function () {
  var ui = await loadTopicControls();
  var selected = topic("close-me", { projectRef: { projectId: CLAY } });
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [selected] }],
  }));
  var confirmed = 0;
  assert.equal(ui.close.requestTopicClose(selected, { confirm: function () { confirmed++; } }), false);
  assert.equal(confirmed, 0);
});

test("the overflow menu is a keyboard-usable menu whose item never navigates the row", async function () {
  var ui = await loadTopicControls();
  var selected = topic("row-topic", { projectRef: { projectId: CLAY }, title: "Row topic" });
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [selected] }],
  }));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  var menu = ui.close.createTopicMenu(known, {
    send: function () { return true; },
  });

  // Menu ARIA contract: haspopup toggle wired to a real menu kept in the DOM.
  var toggle = byClass(menu, "coop-topic-menu-toggle")[0];
  var list = byClass(menu, "coop-topic-menu-list")[0];
  var item = byClass(menu, "coop-topic-menu-item")[0];
  assert.equal(toggle.tagName, "BUTTON");
  assert.equal(toggle.getAttribute("aria-haspopup"), "menu");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), list.id);
  assert.equal(toggle.getAttribute("aria-label"), "Thread options for Row topic");
  assert.equal(list.getAttribute("role"), "menu");
  assert.equal(list.hidden, true, "the menu starts collapsed");
  assert.equal(item.getAttribute("role"), "menuitem");
  assert.equal(item.getAttribute("aria-label"), "Do not implement Row topic");

  // Opening reflects into aria-expanded; the menu stays in the DOM either way.
  toggle.click();
  assert.equal(list.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");

  // Escape closes the menu and returns focus to the toggle.
  var focused = [];
  toggle.focus = function () { focused.push("toggle"); };
  menu.listeners.keydown[0]({ key: "Escape", stopPropagation: function () {} });
  assert.equal(list.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.deepEqual(focused, ["toggle"]);

  // Activating the item stops propagation (never navigates the row), closes
  // the menu, and routes Close through the explicit-outcome custom dialog.
  toggle.click();
  var stopped = 0;
  item.listeners.click[0]({ stopPropagation: function () { stopped++; } });
  assert.equal(stopped, 1);
  assert.equal(list.hidden, true, "acting closes the menu");
  assert.equal(byClass(document.body, "coop-thread-dialog").length, 1);
});

// --- Related-sessions expander ---

function expanderTopic(extra) {
  return topic("with-links", Object.assign({ projectRef: { projectId: CLAY } }, extra || {}));
}

function projectWithTopic(selected) {
  return projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [selected] }],
  });
}

test("the expander starts collapsed and wires ARIA to its panel", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectWithTopic(expanderTopic({
    relatedSessions: [
      { sessionRef: { projectId: CLAY, sessionStorageId: "coordinator-a" }, projectRef: { projectId: CLAY }, title: "Sidebar work" },
    ],
  })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  var wrapper = ui.links.createTopicLinksExpander(known, { send: function () { return true; } });
  var toggle = byClass(wrapper, "coop-topic-links-toggle")[0];

  assert.equal(ui.links.isTopicLinksExpanded(known), false);
  assert.equal(toggle.tagName, "BUTTON");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "Related sessions (1)");
  // aria-controls must resolve to a real element even while collapsed, so the
  // panel stays in the DOM and is hidden instead of being omitted.
  var panel = byClass(wrapper, "coop-topic-links")[0];
  assert.ok(panel, "the controlled panel exists while collapsed");
  assert.equal(toggle.getAttribute("aria-controls"), panel.id);
  assert.equal(panel.hidden, true, "a collapsed panel is hidden, not merely empty");
});

test("expanding lists only session titles and navigates by exact ProjectRef/SessionRef", async function () {
  var ui = await loadTopicControls();
  var sessionRef = { projectId: CLAY, sessionStorageId: "coordinator-a" };
  ui.projection.setGlobalCoopProjection(projectWithTopic(expanderTopic({
    relatedSessions: [{ sessionRef: sessionRef, projectRef: { projectId: CLAY }, title: "Sidebar work" }],
  })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];

  assert.equal(ui.links.toggleTopicLinks(known), true);
  var sent = [];
  var navigated = 0;
  var wrapper = ui.links.createTopicLinksExpander(known, {
    send: function (message) { sent.push(message); return true; },
    onNavigate: function () { navigated++; },
  });
  var toggle = byClass(wrapper, "coop-topic-links-toggle")[0];
  var panel = byClass(wrapper, "coop-topic-links")[0];
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(panel.hidden, false, "an expanded panel is not hidden");
  assert.equal(panel.getAttribute("aria-labelledby"), toggle.id);
  assert.equal(panel.getAttribute("role"), "group");

  var linkRows = byClass(wrapper, "coop-topic-link");
  assert.equal(linkRows.length, 1);
  assert.equal(linkRows[0].textContent, "Sidebar work");
  // Exact references drive navigation but are never written into the DOM.
  assert.deepEqual(linkRows[0].dataset, {});
  assert.equal(JSON.stringify(linkRows[0].attributes).indexOf("coordinator-a"), -1);

  linkRows[0].click();
  assert.deepEqual(sent, [{ type: "resolve_session_ref", sessionRef: sessionRef }]);
  assert.equal(navigated, 1);

  // Toggling is per topic and reverses cleanly.
  assert.equal(ui.links.toggleTopicLinks(known), false);
  assert.equal(ui.links.isTopicLinksExpanded(known), false);
});

test("expansion state is tracked per topic and per project, not globally", async function () {
  var ui = await loadTopicControls();
  var mine = { topicRef: { topicId: "shared" }, projectRef: { projectId: CLAY } };
  var other = { topicRef: { topicId: "shared" }, projectRef: { projectId: WEBAPP } };
  var unrelated = { topicRef: { topicId: "different" }, projectRef: { projectId: CLAY } };
  ui.links.toggleTopicLinks(mine);
  assert.equal(ui.links.isTopicLinksExpanded(mine), true);
  assert.equal(ui.links.isTopicLinksExpanded(other), false);
  assert.equal(ui.links.isTopicLinksExpanded(unrelated), false);
  assert.notEqual(ui.links.topicLinksSignature(), "{}");
  ui.links.toggleTopicLinks(mine);
  assert.equal(ui.links.topicLinksSignature(), "{}");
});

test("a topic with no visible related sessions renders no expander at all", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectWithTopic(expanderTopic()));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  // Not even when the owner previously expanded a same-named topic.
  ui.links.toggleTopicLinks(known);
  assert.equal(ui.links.createTopicLinksExpander(known, { send: function () { return true; } }), null);
  assert.equal(ui.links.createTopicLinksExpander(known, { mobile: true, send: function () { return true; } }), null);
});

test("a topic whose links were all ACL-filtered away renders no expander", async function () {
  var ui = await loadTopicControls();
  // The server dropped every worker/hidden/revoked link, leaving an empty array.
  ui.projection.setGlobalCoopProjection(projectWithTopic(expanderTopic({ relatedSessions: [] })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  assert.deepEqual(known.relatedSessions, []);
  assert.equal(ui.links.createTopicLinksExpander(known, { send: function () { return true; } }), null);
});

test("a populated expander is a collapsed disclosure with an exact count on both surfaces", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectWithTopic(expanderTopic({
    relatedSessions: [
      { sessionRef: { projectId: CLAY, sessionStorageId: "coordinator-a" }, projectRef: { projectId: CLAY }, title: "Sidebar work" },
      { sessionRef: { projectId: CLAY, sessionStorageId: "coordinator-b" }, projectRef: { projectId: CLAY }, title: "Identity work" },
    ],
  })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];

  [false, true].forEach(function (mobile) {
    var prefix = mobile ? "mobile-" : "";
    var surface = mobile ? "mobile" : "desktop";
    var wrapper = ui.links.createTopicLinksExpander(known, { mobile: mobile, send: function () { return true; } });
    assert.ok(wrapper, surface + " renders the expander when links exist");
    var toggle = byClass(wrapper, prefix + "coop-topic-links-toggle")[0];
    var panel = byClass(wrapper, prefix + "coop-topic-links")[0];
    assert.equal(toggle.textContent, "Related sessions (2)", surface + " states the exact count");
    assert.equal(toggle.getAttribute("aria-expanded"), "false", surface + " starts collapsed");
    // The collapsed disclosure must still resolve aria-controls to a real element.
    assert.ok(panel, surface + " keeps the controlled panel in the DOM while collapsed");
    assert.equal(toggle.getAttribute("aria-controls"), panel.id);
    assert.equal(panel.getAttribute("aria-labelledby"), toggle.id);
    assert.equal(panel.hidden, true, surface + " hides the collapsed panel");
    assert.equal(byClass(wrapper, prefix + "coop-topic-link").length, 2);
  });
});

test("the row builder appends the expander only when one was produced", function () {
  // createTopicLinksExpander returns null for a topic with no visible links, so
  // an unguarded appendChild would throw and a truthy-guard regression would
  // reintroduce an empty expander row.
  var topics = source("sidebar-coop-topics.js");
  var row = source("sidebar-coop-topic-row.js");
  assert.match(row, /var expander = createTopicLinksExpander\(topic, opts\);/);
  assert.match(row, /if \(expander\) wrapper\.appendChild\(expander\);/);
  // No empty-state affordance survives anywhere.
  assert.doesNotMatch(topics, /No related project sessions|coop-topic-links-empty/);
  assert.doesNotMatch(source("sidebar-coop-topic-links.js"), /No related project sessions|coop-topic-links-empty/);
});

test("the expander cannot navigate without a transport", async function () {
  var ui = await loadTopicControls();
  var sessionRef = { projectId: CLAY, sessionStorageId: "coordinator-a" };
  ui.projection.setGlobalCoopProjection(projectWithTopic(expanderTopic({
    relatedSessions: [{ sessionRef: sessionRef, projectRef: { projectId: CLAY }, title: "Sidebar work" }],
  })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  ui.links.toggleTopicLinks(known);
  var navigated = 0;
  var wrapper = ui.links.createTopicLinksExpander(known, { onNavigate: function () { navigated++; } });
  byClass(wrapper, "coop-topic-link")[0].click();
  assert.equal(navigated, 0);
});

test("mobile uses the same expander with mobile class names", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectWithTopic(expanderTopic({
    relatedSessions: [{ sessionRef: { projectId: CLAY, sessionStorageId: "coordinator-a" }, title: "Sidebar work" }],
  })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  ui.links.toggleTopicLinks(known);
  var wrapper = ui.links.createTopicLinksExpander(known, { mobile: true, send: function () { return true; } });
  assert.equal(byClass(wrapper, "mobile-coop-topic-links-toggle").length, 1);
  assert.equal(byClass(wrapper, "mobile-coop-topic-link").length, 1);
  assert.equal(byClass(wrapper, "coop-topic-links-toggle").length, 0);
});

// --- Reference hygiene ---

test("the client topic model drops worker roles, nesting, task refs, and attempts", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectWithTopic(topic("hardened", {
    projectRef: { projectId: CLAY },
    relatedSessions: [
      {
        sessionRef: { projectId: CLAY, sessionStorageId: "top-level" },
        projectRef: { projectId: CLAY },
        title: "Top level work",
        // Fields a server regression might reintroduce. None may survive.
        role: "worker",
        status: "running",
        taskRef: { projectId: CLAY, taskId: "task-1" },
        attempt: 3,
        attemptCount: 5,
        children: [{ sessionRef: { projectId: CLAY, sessionStorageId: "worker-1" }, title: "Worker 1" }],
      },
      // Duplicate reference: one link only.
      { sessionRef: { projectId: CLAY, sessionStorageId: "top-level" }, title: "Top level work again" },
      // Unusable reference: dropped rather than half-rendered.
      { title: "No reference" },
    ],
  })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  var links = known.relatedSessions;
  assert.equal(links.length, 1);
  assert.deepEqual(Object.keys(links[0]).sort(), ["projectRef", "sessionRef", "title"]);
  assert.equal(JSON.stringify(links).indexOf("worker-1"), -1);
  assert.equal(JSON.stringify(links).indexOf("task-1"), -1);

  ui.links.toggleTopicLinks(known);
  var wrapper = ui.links.createTopicLinksExpander(known, { send: function () { return true; } });
  var rendered = JSON.stringify(descendants(wrapper).map(function (node) {
    return { c: node.className, t: node.textContent, a: node.attributes, d: node.dataset };
  }));
  assert.equal(rendered.indexOf("worker"), -1);
  assert.equal(rendered.indexOf("task-1"), -1);
  assert.equal(rendered.indexOf("attempt"), -1);
});

test("legacy worker-shaped payloads are ignored rather than translated", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectWithTopic(topic("legacy", {
    projectRef: { projectId: CLAY },
    // The pre-change server field. It must not repopulate the expander.
    relatedExecution: [{ sessionRef: { projectId: CLAY, sessionStorageId: "legacy-worker" }, role: "worker" }],
    relatedExecutions: [{ sessionRef: { projectId: CLAY, sessionStorageId: "legacy-worker-2" }, role: "worker" }],
  })));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  assert.deepEqual(known.relatedSessions, []);
  assert.equal(Object.prototype.hasOwnProperty.call(known, "relatedExecution"), false);
});

test("no forbidden Coop sidebar affordance reappears", function () {
  var topics = source("sidebar-coop-topics.js");
  var topicRows = source("sidebar-coop-topic-row.js");
  var links = source("sidebar-coop-topic-links.js");
  var closeSource = source("sidebar-coop-topic-close.js");
  var controls = source("coop-thread-controls.js");
  var model = source("sidebar-coop-topic-model.js");
  var all = topics + topicRows + links + closeSource + controls + model;
  assert.doesNotMatch(all, /New topic|coop-topic-create|coop_topic_create/);
  assert.doesNotMatch(all, /report-card|reportCard|coop-topic-diagnostics/);
  assert.doesNotMatch(all, /coop-topic-actions|coop-topic-drawer|coop-topic-details/);
  // Never the browser-native dialogs.
  assert.doesNotMatch(all, /window\.confirm|[^.\w]confirm\(["']|window\.alert|window\.prompt/);
  // Topic-related links stay flat. The separate project hierarchy renderer may
  // show current coordinator rows, but topic payloads never regrow worker trees.
  assert.doesNotMatch(all, /relatedExecutions|cloneRelatedExecution/);
  // The two leaf controls stay independent of the app connection graph.
  assert.doesNotMatch(links, /from '\.\/app-connection\.js'/);
  assert.doesNotMatch(closeSource, /from '\.\/app-connection\.js'/);
});

// --- ARIA wiring for the decision panel and omitted Closed navigation ---

test("the decision panel stays accessible and Closed navigation is absent", function () {
  // The review panel moved into the topic decision surface: it renders as a
  // labelled group, always open, and never as a sidebar disclosure toggle.
  var review = source("sidebar-coop-topic-review.js");
  assert.match(review, /var panelId = prefix \+ "coop-topic-review-panel-" \+ id\.replace/,
    "review panel ids stay stable per topic");
  assert.match(review, /wrapper\.setAttribute\("role", "group"\)/);
  assert.match(review, /wrapper\.setAttribute\("aria-label", "Decide Thread "/);
  assert.doesNotMatch(review, /aria-expanded/,
    "no disclosure semantics remain: the panel is always open in context");
  assert.doesNotMatch(review, /createTopicReviewControl/,
    "the sidebar Review toggle is gone");

  var topics = source("sidebar-coop-topics.js");
  assert.doesNotMatch(topics, /coop-topic-done-panel|coopClosedSectionOpen|Closed \(/);
});

// --- Topic-row layout contract (title primary, quiet meta line, one overflow) ---

test("the Thread row keeps the title primary and shows lifecycle text plus an inline dot", function () {
  var topics = source("sidebar-coop-topic-row.js");
  // The title is the primary content; the status dot is now inline within the
  // row button for a single compact row. No secondary meta line is created.
  var rowBuilder = topics.slice(topics.indexOf("export function createCoopTopicRow("));
  rowBuilder = rowBuilder.slice(0, rowBuilder.indexOf("\nfunction ", 1));
  assert.ok(rowBuilder.indexOf("row.appendChild(title)") !== -1);
  assert.ok(rowBuilder.indexOf("row.appendChild(marker)") !== -1,
    "the status dot is appended to the row button, not to a secondary meta line");
  assert.ok(rowBuilder.indexOf("row.appendChild(stateLabel)") !== -1,
    "the lifecycle state is visible in words on desktop and mobile");
  assert.doesNotMatch(rowBuilder, /meta\.appendChild\(activityEl\)|meta\.appendChild\(marker\)/,
    "no meta line or activity text is rendered");
  assert.doesNotMatch(rowBuilder, /createTopicReviewControl/);
  // The row's accessible name still announces the state even though only the
  // dot is visible.
  assert.ok(rowBuilder.indexOf("topicAriaLabel(topic, activity)") !== -1);
  // The dot has a title attribute and uses the explicit lifecycle state class.
  assert.match(rowBuilder, /marker\.setAttribute\("title", activity\.label\)/);
  assert.match(rowBuilder, /topicStatusClass\(activity\.status\)/);
  assert.doesNotMatch(rowBuilder, /data-animating/);
  // No status text appears anywhere in the row.
  assert.doesNotMatch(topics, /\.coop-topic-activity {/);
  assert.doesNotMatch(topics, /\.coop-topic-meta {/);
  // Mobile uses the same structure with mobile class names.
  var mobile = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"), "utf8");
  assert.doesNotMatch(mobile, /\.mobile-coop-topic-activity {/);
  assert.doesNotMatch(mobile, /\.mobile-coop-topic-meta {/);
  var css = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"), "utf8");
  assert.match(css, /\.coop-topic-status-exploring \{ background: var\(--accent\)/);
  assert.match(css, /\.coop-topic-status-parked \{ background: var\(--warning/);
  assert.match(css, /\.coop-topic-status-working .*animation: vendor-dot-pulse/);
  var queuedRule = css.match(/\.coop-topic-status-queued \{[^}]+\}/)[0];
  assert.match(queuedRule, /opacity: \.48/);
  assert.doesNotMatch(queuedRule, /animation:/);
  assert.match(css, /\.coop-topic-status-closed,/);
});

test("Thread rows expose no lifecycle control menu", function () {
  var closeSource = source("sidebar-coop-topic-close.js");
  // The legacy helper remains covered for compatibility, but the live row no
  // longer mounts it; owner language is the lifecycle control.
  assert.match(closeSource, /toggle\.setAttribute\("aria-haspopup", "menu"\)/);
  assert.match(closeSource, /toggle\.setAttribute\("aria-controls", menuId\)/);
  assert.match(closeSource, /list\.setAttribute\("role", "menu"\)/);
  assert.match(closeSource, /item\.setAttribute\("role", "menuitem"\)/);
  // Close still routes through the explicit confirmation and Reopen does not.
  assert.match(closeSource, /if \(closed\) requestTopicReopen\(topic, opts\);\s*else requestTopicClose\(topic, opts\);/);
  // Escape closes and returns focus to the toggle; leaving focus dismisses.
  assert.match(closeSource, /event\.key !== "Escape"/);
  assert.match(closeSource, /toggle\.focus\(\)/);
  assert.match(closeSource, /addEventListener\("focusout"/);
  // No lifecycle affordance survives on the live row.
  var topics = source("sidebar-coop-topics.js") + source("sidebar-coop-topic-row.js");
  assert.doesNotMatch(topics, /createTopicMenu|sidebar-coop-topic-close/);
  assert.doesNotMatch(topics, /createTopicCloseButton/);
});

test("Thread rows keep lifecycle styling out of the live menu", function () {
  var desktop = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"), "utf8");
  var mobile = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"), "utf8");
  // The meta line and activity styles are removed (dot is now inline). The
  // legacy menu CSS may remain for compatibility, but no row mounts it.
  assert.doesNotMatch(desktop, /\.coop-topic-meta/);
  assert.doesNotMatch(desktop, /\.coop-topic-activity/);
  assert.doesNotMatch(mobile, /\.mobile-coop-topic-meta/);
  assert.doesNotMatch(mobile, /\.mobile-coop-topic-activity/);
  assert.ok(mobile.indexOf("mobile-coop-topic") !== -1);
});
