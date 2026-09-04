var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

function thread() {
  return {
    topicRef: { topicId: "thread-a" },
    threadRef: { threadId: "thread-a" },
    title: "Renderer caching",
    threadState: "exploring",
    lastTurnRef: { projectId: "system-lead", sessionStorageId: "canonical-coop",
      startEventIndex: 8, endEventIndex: 10 },
  };
}

test("Thread controls emit reference-only lifecycle and correction messages", async function () {
  var controls = await import(moduleUrl("coop-thread-controls.js"));
  var selected = thread();
  assert.deepEqual(controls.buildThreadControlMessage("state", selected, {
    state: "closed", closeOutcome: "not_pursuing",
  }), {
    type: "coop_thread_state", topicRef: { topicId: "thread-a" },
    threadRef: { threadId: "thread-a" }, state: "closed", closeOutcome: "not_pursuing",
  });
  assert.deepEqual(controls.buildThreadControlMessage("reassign", selected, {
    targetThreadRef: { threadId: "thread-b" },
  }), {
    type: "coop_thread_reassign", topicRef: { topicId: "thread-a" },
    threadRef: { threadId: "thread-a" }, sourceThreadRef: { threadId: "thread-a" },
    targetThreadRef: { threadId: "thread-b" }, turnRef: selected.lastTurnRef,
  });
  assert.deepEqual(controls.buildThreadControlMessage("merge", selected, {
    targetThreadRef: { threadId: "thread-b" },
  }), {
    type: "coop_thread_merge", topicRef: { topicId: "thread-a" },
    threadRef: { threadId: "thread-a" }, sourceThreadRefs: [{ threadId: "thread-a" }],
    targetThreadRef: { threadId: "thread-b" },
  });
  assert.deepEqual(controls.buildThreadControlMessage("undo", selected), {
    type: "coop_thread_undo", topicRef: { topicId: "thread-a" },
    threadRef: { threadId: "thread-a" },
  });
});

test("the selected automatic Thread is surfaced on its owner turn", async function () {
  var route = await import(moduleUrl("coop-thread-route.js"));
  var inserted = [];
  var host = {
    firstChild: null,
    querySelector: function () { return null; },
    insertBefore: function (child) { inserted.push(child); },
  };
  globalThis.document = {
    createElement: function () {
      return { className: "", dataset: {}, textContent: "", attributes: {},
        setAttribute: function (name, value) { this.attributes[name] = String(value); } };
    },
  };
  assert.equal(route.applyCoopThreadRoute(host, {
    coopThreadRef: { threadId: "auto-111111111111111111111111" },
    coopThreadTitle: "Renderer caching",
  }), true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].textContent, "Thread: Renderer caching");
  assert.equal(inserted[0].dataset.threadId, "auto-111111111111111111111111");
  assert.equal(inserted[0].attributes["aria-label"], "Routed to Thread Renderer caching");
});
