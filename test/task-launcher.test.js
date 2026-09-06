var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var { attachTaskLauncher } = require("../lib/project-task-launcher");

function flushPromises() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function writeRecipe(cwd) {
  var tasksDir = path.join(cwd, ".clay", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, "bugs.json"), JSON.stringify({
    id: "bugs",
    name: "Bugs",
    source: { provider: "github", kind: "issues", repo: "owner/repo" },
    launch: { defaultLimit: 10 },
    session: { title: "Issue #{number} {title}", vendor: "claude" },
    completion: {},
  }, null, 2) + "\n");
}

function makeItem(number, title) {
  return {
    number: number,
    title: title,
    url: "https://github.com/owner/repo/issues/" + number,
    body: "Body " + number,
    labels: [],
    assignees: [],
  };
}

function makeHarness(fetchItemsAsync, coordinateExternalTask) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-tasklauncher-"));
  writeRecipe(cwd);
  var messages = [];
  var sessions = new Map();
  var startQueries = [];
  var switched = [];
  var broadcasts = 0;
  var saves = 0;
  var processingChanged = 0;
  var nextId = 1;
  var sm = {
    sessions: sessions,
    defaultVendor: "claude",
    serverDefaultMode: "default",
    createSessionRaw: function (opts) {
      var session = Object.assign({
        localId: nextId++,
        history: [],
      }, opts || {});
      sessions.set(session.localId, session);
      return session;
    },
    appendToSessionFile: function () {},
    saveSessionFile: function () { saves++; },
    switchSession: function (id) { switched.push(id); },
    broadcastSessionList: function () { broadcasts++; },
  };
  var launcher = attachTaskLauncher({
    cwd: cwd,
    sm: sm,
    sdk: {
      startQuery: function (session, prompt, unused, access) {
        startQueries.push({ session: session, prompt: prompt, access: access });
      },
    },
    sendTo: function (ws, msg) { messages.push(msg); },
    usersModule: { isMultiUser: function () { return false; } },
    getSessionForWs: function () { return null; },
    ensureProjectAccessForSession: function () { return "access-ok"; },
    onProcessingChanged: function () { processingChanged++; },
    fetchItemsAsync: fetchItemsAsync,
    coordinateExternalTask: coordinateExternalTask,
  });
  return {
    cwd: cwd,
    sm: sm,
    launcher: launcher,
    messages: messages,
    sessions: sessions,
    startQueries: startQueries,
    switched: switched,
    broadcasts: function () { return broadcasts; },
    saves: function () { return saves; },
    processingChanged: function () { return processingChanged; },
    ws: { _clayUser: null },
  };
}

function cleanupHarness(h) {
  fs.rmSync(h.cwd, { recursive: true, force: true });
}

test("task launch preview acks immediately and reports async results", async function () {
  var fetchCalls = [];
  var h = makeHarness(function (cwd, recipe, args) {
    fetchCalls.push({ cwd: cwd, recipe: recipe, args: args });
    return Promise.resolve([makeItem(1, "Fix login"), makeItem(2, "Fix signup")]);
  });
  try {
    var handled = h.launcher.handleLaunchMessage(h.ws, { type: "task_launch", command: "/launch preview bugs limit:2" });
    assert.strictEqual(handled, true);
    assert.strictEqual(h.messages.length, 1);
    assert.strictEqual(h.messages[0].type, "slash_command_result");
    assert.ok(h.messages[0].text.indexOf("Scanning bugs tasks") === 0);

    await flushPromises();

    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].cwd, h.cwd);
    assert.strictEqual(fetchCalls[0].recipe.id, "bugs");
    assert.strictEqual(fetchCalls[0].args.limit, "2");
    assert.strictEqual(h.messages.length, 2);
    assert.ok(h.messages[1].text.indexOf("2 matching items") !== -1);
    assert.ok(h.messages[1].text.indexOf("#1 Fix login") !== -1);
  } finally {
    cleanupHarness(h);
  }
});

test("task launch start dedups existing sessions and starts new items", async function () {
  var h = makeHarness(function () {
    return Promise.resolve([makeItem(1, "Existing bug"), makeItem(2, "New bug")]);
  });
  try {
    h.sessions.set(99, {
      localId: 99,
      taskLauncher: {
        recipeId: "bugs",
        itemNumber: 1,
        itemUrl: "https://github.com/owner/repo/issues/1",
      },
    });

    h.launcher.handleLaunchMessage(h.ws, { type: "task_launch", command: "/launch start bugs" });
    await flushPromises();

    assert.strictEqual(h.startQueries.length, 1);
    assert.strictEqual(h.startQueries[0].session.taskLauncher.itemNumber, 2);
    assert.strictEqual(h.startQueries[0].access, "access-ok");
    assert.strictEqual(h.switched.length, 1);
    assert.strictEqual(h.switched[0], h.startQueries[0].session.localId);
    assert.strictEqual(h.broadcasts(), 1);
    assert.strictEqual(h.processingChanged(), 1);
    assert.ok(h.messages[h.messages.length - 1].text.indexOf("Started 1 task session") !== -1);
    assert.ok(h.messages[h.messages.length - 1].text.indexOf("Skipped 1") !== -1);
  } finally {
    cleanupHarness(h);
  }
});

test("task launch reports fetch rejection as a slash command result", async function () {
  var h = makeHarness(function () {
    return Promise.reject(new Error("fetch failed"));
  });
  try {
    h.launcher.handleLaunchMessage(h.ws, { type: "task_launch", command: "/launch preview bugs" });
    await flushPromises();

    assert.strictEqual(h.messages.length, 2);
    assert.strictEqual(h.messages[1].type, "slash_command_result");
    assert.strictEqual(h.messages[1].text, "Task launcher failed: fetch failed");
  } finally {
    cleanupHarness(h);
  }
});

test("launchExternal resolves ok and starts a session", async function () {
  var h = makeHarness(function (cwd, recipe, args) {
    assert.strictEqual(args.issue, "5");
    return Promise.resolve([makeItem(5, "Dashboard bug")]);
  });
  try {
    var result = await h.launcher.launchExternal({ recipe: "bugs", issue: 5 }, null);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.localSessionId, 1);
    assert.strictEqual(result.title, "Issue #5 Dashboard bug");
    assert.strictEqual(h.startQueries.length, 1);
    assert.strictEqual(h.switched[0], 1);
    assert.strictEqual(h.broadcasts(), 1);
  } finally {
    cleanupHarness(h);
  }
});

test("task launcher persists the canonical issue key when the source omits item.key", function () {
  var h = makeHarness(function () { return Promise.resolve([]); });
  try {
    var recipe = h.launcher.loadRecipe("bugs");
    var session = h.launcher.startSessionForItem(null, recipe,
      makeItem(42, "Missing source key"), {}, null, { auto: true });

    assert.strictEqual(session.taskLauncher.itemKey, "owner/repo#42");
    assert.strictEqual(session.taskLauncher.prKey, null);
  } finally {
    cleanupHarness(h);
  }
});

test("launchExternal resolves an error object when async fetch fails", async function () {
  var h = makeHarness(function () {
    return Promise.reject(new Error("worker down"));
  });
  try {
    var promise = null;
    assert.doesNotThrow(function () {
      promise = h.launcher.launchExternal({ recipe: "bugs", issue: 6 }, null);
    });
    assert.ok(promise && typeof promise.then === "function");

    var result = await promise;
    assert.deepStrictEqual(result, { ok: false, error: "worker down" });
    assert.strictEqual(h.startQueries.length, 0);
  } finally {
    cleanupHarness(h);
  }
});

test("launchExternal routes Framer context through an existing coordinator", async function () {
  var coordinated = [];
  var h = makeHarness(function () {
    return Promise.resolve([makeItem(12, "Match payment error state")]);
  }, function (input) {
    coordinated.push(input);
    return {
      ok: true,
      coordinatorSessionId: "coordinator-storage",
      orchestrationTaskId: "task-framer",
      workerSessionId: 22,
    };
  });
  try {
    var result = await h.launcher.launchExternal({
      recipe: "bugs",
      issue: 12,
      source: "framer",
      coordinatorSessionId: "coordinator-storage",
      context: "Page: Checkout. Selection: PaymentForm/Error.",
      acceptanceCriteria: "Match desktop and mobile variants.",
      ownedPaths: "Payment form UI.",
      clientRef: "framer-42",
    }, null);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.orchestrationTaskId, "task-framer");
    assert.strictEqual(coordinated.length, 1);
    assert.strictEqual(coordinated[0].coordinatorSessionId, "coordinator-storage");
    assert.strictEqual(coordinated[0].title, "Issue #12 Match payment error state");
    assert.ok(coordinated[0].objective.indexOf("Body 12") !== -1);
    assert.ok(coordinated[0].context.indexOf("Task source: framer.") !== -1);
    assert.ok(coordinated[0].context.indexOf("PaymentForm/Error") !== -1);
    assert.strictEqual(coordinated[0].acceptanceCriteria, "Match desktop and mobile variants.");
    assert.strictEqual(coordinated[0].ownedPaths, "Payment form UI.");
    assert.strictEqual(coordinated[0].clientRef, "framer-42");
    assert.strictEqual(h.startQueries.length, 0);
    assert.strictEqual(h.switched.length, 0);
  } finally {
    cleanupHarness(h);
  }
});

test("sentry tasks render Sentry variables and keep sentry autoKind", function () {
  var h = makeHarness(function () {
    return Promise.resolve([]);
  });
  try {
    var tasksDir = path.join(h.cwd, ".clay", "tasks");
    fs.writeFileSync(path.join(tasksDir, "sentry.md"), "Sentry {{sentry_short_id}} {{related_github_refs}}\n{{sentry_permalink}}\n");
    var recipe = {
      id: "sentry-related",
      source: { provider: "sentry", kind: "findings", githubRepo: "owner/repo" },
      prompt: { template: "sentry.md" },
      session: { title: "Sentry {sentry_short_id} {title}" },
      completion: {},
    };
    var item = {
      number: "123456",
      title: "TypeError",
      url: "https://sentry.example/issues/123456",
      key: "sentry:acme/webapp#123456",
      sentry_short_id: "WEBAPP-9",
      sentry_permalink: "https://sentry.example/issues/123456",
      related_github_refs: "owner/repo issue #22",
    };

    var session = h.launcher.startSessionForItem(null, recipe, item, {}, null, { auto: true });

    assert.strictEqual(session.taskLauncher.autoKind, "sentry");
    assert.strictEqual(session.taskLauncher.itemKey, "sentry:acme/webapp#123456");
    assert.strictEqual(session.title, "Sentry WEBAPP-9 TypeError");
    assert.ok(h.startQueries[0].prompt.indexOf("Sentry WEBAPP-9 owner/repo issue #22") !== -1);
    assert.ok(h.startQueries[0].prompt.indexOf("https://sentry.example/issues/123456") !== -1);
  } finally {
    cleanupHarness(h);
  }
});

test("task launcher defaults to the best Claude model", function () {
  var h = makeHarness(function () { return Promise.resolve([]); });
  try {
    h.sm.modelsByVendor = {
      claude: [{ value: "default" }, { value: "best" }, { value: "claude-opus-4-8" }],
    };
    var recipe = h.launcher.loadRecipe("bugs");
    var session = h.launcher.startSessionForItem(null, recipe, makeItem(7, "Model routing"), {}, null, { auto: true });

    assert.strictEqual(session.model, "best");
    assert.ok(h.startQueries[0].prompt.indexOf("PROVIDER-MATCHED AGENT PIPELINE") !== -1);
    assert.ok(h.startQueries[0].prompt.indexOf("Claude workers to Opus") !== -1);
  } finally {
    cleanupHarness(h);
  }
});

test("task launcher defaults to Sol but preserves an explicit model pin", function () {
  var h = makeHarness(function () { return Promise.resolve([]); });
  try {
    h.sm.modelsByVendor = {
      codex: [{ value: "gpt-5.6-terra", isDefault: true }, { value: "gpt-5.6-sol" }],
    };
    var recipe = h.launcher.loadRecipe("bugs");
    recipe.session.vendor = "codex";
    var bestSession = h.launcher.startSessionForItem(null, recipe, makeItem(8, "Best model"), {}, null, { auto: true });
    assert.strictEqual(bestSession.model, "gpt-5.6-sol");
    assert.ok(h.startQueries[0].prompt.indexOf("Codex workers to Terra") !== -1);

    recipe.session.model = "gpt-5.6-terra";
    var pinnedSession = h.launcher.startSessionForItem(null, recipe, makeItem(9, "Pinned model"), {}, null, { auto: true });
    assert.strictEqual(pinnedSession.model, "gpt-5.6-terra");
  } finally {
    cleanupHarness(h);
  }
});
