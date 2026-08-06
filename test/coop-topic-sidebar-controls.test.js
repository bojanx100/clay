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
  node.addEventListener = function (type, handler) {
    node.listeners[type] = (node.listeners[type] || []).concat(handler);
  };
  node.click = function () {
    var handlers = node.listeners.click || [];
    for (var i = 0; i < handlers.length; i++) handlers[i]({ stopPropagation: function () {} });
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
  globalThis.document = { createElement: createElement, getElementById: function () { return null; } };
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

test("Uncategorised renders first and every empty category wrapper is omitted", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [
      { projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", icon: "C", topics: [topic("clay-one", { projectRef: { projectId: CLAY } })] },
      // Accessible but with nothing classified to it: must yield no section.
      { projectRef: { projectId: WEBAPP }, slug: "webapp", title: "Webapp", topics: [] },
    ],
    topics: [topic("cross-one", { group: "cross_project" }), topic("uncat-one", { group: "uncategorised" })],
  }));
  var sections = ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""));
  assert.deepEqual(sectionShape(sections), [
    "uncategorised:Uncategorised",
    "project:Clay",
    "cross_project:Cross-project",
  ]);
  assert.equal(sections[1].icon, "C");
  assert.deepEqual(sections[1].projectRef, { projectId: CLAY });
});

test("an empty Uncategorised category leaves no descriptor behind", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [topic("clay-one", { projectRef: { projectId: CLAY } })] }],
    topics: [],
  }));
  assert.deepEqual(
    sectionShape(ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel(""))),
    ["project:Clay"]
  );
});

test("every category empty yields no sections at all", async function () {
  var ui = await loadTopicControls();
  assert.deepEqual(ui.model.coopTopicSections({}), []);
  assert.deepEqual(ui.model.coopTopicSections(null), []);
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [] }],
    topics: [],
  }));
  assert.deepEqual(ui.model.coopTopicSections(ui.projection.buildGlobalCoopDisplayModel("")), []);
});

test("search filtering can empty a category and it then renders no wrapper", async function () {
  var ui = await loadTopicControls();
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [topic("clay-one", { projectRef: { projectId: CLAY }, title: "Sidebar work" })] }],
    topics: [topic("uncat-one", { group: "uncategorised", title: "Unrelated" })],
  }));
  var filtered = ui.projection.buildGlobalCoopDisplayModel("sidebar");
  assert.deepEqual(sectionShape(ui.model.coopTopicSections(filtered)), ["project:Clay"]);
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

// --- Close action ---

test("cancelling Close is a strict no-op and confirming closes exactly once", async function () {
  var ui = await loadTopicControls();
  var selected = topic("close-me", { projectRef: { projectId: CLAY }, title: "Closable topic" });
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [selected] }],
  }));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];

  var sent = [];
  var prompts = [];
  function confirm(text, onConfirm, okLabel, destructive, cancelLabel) {
    prompts.push({ text: text, okLabel: okLabel, destructive: destructive, cancelLabel: cancelLabel, onConfirm: onConfirm });
  }
  function send(message) { sent.push(message); return true; }

  assert.equal(ui.close.requestTopicClose(known, { confirm: confirm, send: send }), true);
  assert.equal(prompts.length, 1);
  // Opening the confirmation sends nothing; cancelling simply never calls back.
  assert.equal(sent.length, 0);
  assert.match(prompts[0].text, /Closable topic/);
  assert.equal(prompts[0].okLabel, "Close topic");
  assert.equal(prompts[0].cancelLabel, "Cancel");
  assert.equal(prompts[0].destructive, false);

  prompts[0].onConfirm();
  prompts[0].onConfirm();
  assert.equal(sent.length, 1, "a repeated confirmation must not close twice");
  assert.deepEqual(sent[0], {
    type: "coop_topic_close",
    topicRef: { topicId: "close-me" },
    projectRef: { projectId: CLAY },
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
  var pending = null;
  assert.equal(ui.close.requestTopicClose(known, {
    confirm: function (text, onConfirm) { pending = onConfirm; },
    send: function (message) { sent.push(message); return true; },
  }), true);

  // While the modal is open the topic is merged away, so a refreshed projection
  // no longer contains it. Closing the captured copy would re-add it as closed.
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [] }],
  }));
  pending();
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

test("the close button stops the click so it never navigates the row", async function () {
  var ui = await loadTopicControls();
  var selected = topic("row-topic", { projectRef: { projectId: CLAY }, title: "Row topic" });
  ui.projection.setGlobalCoopProjection(projectionMessage({
    projects: [{ projectRef: { projectId: CLAY }, slug: "clay", title: "Clay", topics: [selected] }],
  }));
  var known = ui.projection.buildGlobalCoopDisplayModel("").projects[0].topics[0];
  var stopped = 0;
  var prompts = [];
  var button = ui.close.createTopicCloseButton(known, {
    confirm: function (text, onConfirm) { prompts.push(onConfirm); },
    send: function () { return true; },
  });
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.className, "coop-topic-close");
  assert.equal(button.getAttribute("aria-label"), "Close topic Row topic");
  button.listeners.click[0]({ stopPropagation: function () { stopped++; } });
  assert.equal(stopped, 1);
  assert.equal(prompts.length, 1);
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
  assert.match(topics, /var expander = createTopicLinksExpander\(topic, options\);/);
  assert.match(topics, /if \(expander\) wrapper\.appendChild\(expander\);/);
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
  var links = source("sidebar-coop-topic-links.js");
  var closeSource = source("sidebar-coop-topic-close.js");
  var model = source("sidebar-coop-topic-model.js");
  var all = topics + links + closeSource + model;
  assert.doesNotMatch(all, /New topic|coop-topic-create|coop_topic_create/);
  assert.doesNotMatch(all, /report-card|reportCard|coop-topic-diagnostics/);
  assert.doesNotMatch(all, /coop-topic-actions|coop-topic-drawer|coop-topic-details/);
  // Never the browser-native dialogs.
  assert.doesNotMatch(all, /window\.confirm|[^.\w]confirm\(["']|window\.alert|window\.prompt/);
  // No worker hierarchy modelling survives on the Coop topic path.
  assert.doesNotMatch(all, /coordinatorTree|relatedExecutions|cloneRelatedExecution/);
  // The two leaf controls stay independent of the app connection graph.
  assert.doesNotMatch(links, /from '\.\/app-connection\.js'/);
  assert.doesNotMatch(closeSource, /from '\.\/app-connection\.js'/);
});
