var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var spawnSync = require("child_process").spawnSync;

function run(t, source) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-preview-schedules-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var config = path.join(root, "daemon-dev.json");
  fs.writeFileSync(config, JSON.stringify({ scheduledExecutionPaused: true }));
  var result = spawnSync(process.execPath, ["-e", [
    'var fs = require("fs"); var path = require("path"); var assert = require("node:assert/strict");',
    'var root = process.env.CLAY_HOME; var file = process.env.CLAY_CONFIG;',
    source,
  ].join("\n")], {
    cwd: path.join(__dirname, ".."), timeout: 10000, encoding: "utf8",
    env: Object.assign({}, process.env, { CLAY_HOME: root, CLAY_CONFIG: config, CLAY_DEV: "1" }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test("paused instance leaves due schedules intact; unpausing executes the same pending record", function (t) {
  run(t, [
    'var registry = require("./lib/scheduler").createLoopRegistry({ cwd: root, onTrigger: function () { triggered++; } });',
    'var triggered = 0;',
    'registry.register({ id: "due", date: "2000-01-01", time: "00:00", source: "schedule" });',
    'var before = JSON.stringify(registry.getAll());',
    'registry.startTimer(); registry.stopTimer();',
    'assert.equal(triggered, 0); assert.equal(JSON.stringify(registry.getAll()), before);',
    'fs.writeFileSync(file, "{}");',
    'registry.startTimer(); registry.stopTimer();',
    'assert.equal(triggered, 1);',
  ].join("\n"));
});

test("paused instance cannot scan through either scheduled auto-launch entry point or drain shared state", function (t) {
  run(t, [
    'var tasks = path.join(root, ".clay", "tasks"); fs.mkdirSync(tasks, { recursive: true });',
    'var recipeConfig = JSON.stringify({ autoLaunch: { enabled: true, recipes: ["assigned-to-me"] } });',
    'fs.writeFileSync(path.join(tasks, "config.json"), recipeConfig);',
    'var reads = 0;',
    'var al = require("./lib/project-auto-launch").attachAutoLaunch({ cwd: root,',
    '  getLeadMode: function () { return true; },',
    '  sm: { sessions: new Map(), getProjectId: function () { return "5332aafc-31e7-5cb1-ba96-c8d90e78260e"; } },',
    '  getTaskLauncher: function () { reads++; return null; } });',
    '(async function () {',
    '  assert.equal((await al.launchScheduled("assigned-to-me")).paused, true);',
    '  assert.equal((await al.runScheduled({ task: "assigned-to-me" })).paused, true);',
    '  assert.equal(al.drainLegacyAutomation().paused, true);',
    '  assert.equal(al.getState().paused, true); assert.equal(reads, 0);',
    '  assert.equal(fs.readFileSync(path.join(tasks, "config.json"), "utf8"), recipeConfig);',
    '  assert.deepEqual(fs.readdirSync(tasks), ["config.json"]);',
    '  fs.writeFileSync(file, "{}"); await al.launchScheduled("assigned-to-me");',
    '  assert.equal(reads, 1); assert.equal(al.getState().paused, false);',
    '})().catch(function (error) { console.error(error); process.exitCode = 1; });',
  ].join("\n"));
});

test("an in-flight scan observes an instance pause before any item processing", function (t) {
  run(t, [
    'fs.writeFileSync(file, "{}"); var processed = 0;',
    'var al = require("./lib/project-auto-launch").attachAutoLaunch({ cwd: root, getLeadMode: function () { return false; },',
    '  getTaskLauncher: function () { return { loadRecipe: function () { return { source: { kind: "issue" } }; } }; },',
    '  fetchItems: function () { fs.writeFileSync(file, JSON.stringify({ scheduledExecutionPaused: true })); return []; } });',
    'al.launchScheduled("assigned-to-me").then(function (result) { assert.equal(result.paused, true); })',
    '  .catch(function (error) { console.error(error); process.exitCode = 1; });',
  ].join("\n"));
});

test("comparison startup retains the saved session set while explicit native discovery remains available", function (t) {
  run(t, [
    'fs.writeFileSync(file, JSON.stringify({ nativeSessionDiscovery: false }));',
    'var config = require("./lib/config"); config.REAL_HOME = root;',
    'var cwd = path.join(root, "project"); fs.mkdirSync(cwd);',
    'var encoded = require("./lib/utils").encodeCwd(cwd);',
    'var saved = path.join(root, "sessions", encoded); fs.mkdirSync(saved, { recursive: true });',
    'fs.writeFileSync(path.join(saved, "saved.jsonl"), JSON.stringify({ type: "meta", storageId: "saved", title: "Saved conversation", hidden: true }) + "\\n");',
    'var native = path.join(root, ".claude", "projects", encoded); fs.mkdirSync(native, { recursive: true });',
    'var id = "12345678-1234-4234-8234-123456789012";',
    'fs.writeFileSync(path.join(native, id + ".jsonl"), JSON.stringify({ type: "user", sessionId: id, timestamp: "2026-09-01T00:00:00Z", message: { role: "user", content: "Extra native conversation" } }) + "\\n");',
    'var create = require("./lib/sessions").createSessionManager;',
    'var manager = create({ cwd: cwd, send: function () {} });',
    'assert.equal(manager.sessions.size, 1); assert.equal(Array.from(manager.sessions.values())[0].hidden, true);',
    'var available = manager.listAdoptableCliSessions("claude");',
    'assert.equal(available.some(function (item) { return item.cliSessionId === id; }), true);',
    'fs.writeFileSync(file, "{}"); var normal = create({ cwd: cwd, send: function () {} });',
    'assert.equal(normal.sessions.size, 2);',
  ].join("\n"));
});

test("comparison startup does not resume interrupted turns or restore saved continuation timers", function (t) {
  run(t, [
    'fs.writeFileSync(file, JSON.stringify({ restoreWorkOnStartup: false }));',
    'var session = { localId: 1, restartResumeEligible: true, restartInterruptedAt: Date.now(), history: [',
    '  { type: "scheduled_message_queued", text: "Continue saved work", resetsAt: Date.now() + 3600000 } ] };',
    'var sm = { sessions: new Map([[1, session]]), sendAndRecord: function () { throw new Error("Unexpected automatic work"); } };',
    'var messages = require("./lib/project-scheduled-messages").attachProjectScheduledMessages({ sm: sm, sdk: {} });',
    'messages.autoResumeRestartSession(session); messages.restoreScheduledMessageTimers();',
    'assert.equal(session.restartResumeEligible, true); assert.equal(session.scheduledMessage, undefined);',
    'assert.equal(session.history.length, 1);',
    'fs.writeFileSync(file, "{}"); messages.restoreScheduledMessageTimers();',
    'assert.ok(session.scheduledMessage.timer); clearTimeout(session.scheduledMessage.timer);',
  ].join("\n"));
});

test("the runtime restart wrapper pauses before it flushes copied owner queues", function (t) {
  run(t, [
    'fs.writeFileSync(file, JSON.stringify({ restoreWorkOnStartup: false }));',
    'var source = fs.readFileSync("lib/project-runtime.js", "utf8");',
    'var start = source.indexOf("  function autoResumeRestartSession(session, options) {");',
    'var end = source.indexOf("\\n  // Records", start);',
    'assert.ok(start >= 0 && end > start);',
    // Exercise the shipped wrapper itself, with only downstream dispatch
    // effects replaced. The nested scheduled-message guard alone is too late.
    'var queued = 0; var resumed = 0;',
    'var resume = new Function("require", "reconcileQueuedUserMessages", "scheduledMessages", source.slice(start, end) + "\\nreturn autoResumeRestartSession;")(',
    '  require("module").createRequire(path.resolve("lib/project-runtime.js")),',
    '  function () { queued++; }, { autoResumeRestartSession: function () { resumed++; } });',
    'resume({ pendingUserMessageQueue: [{ text: "Copied request" }] });',
    'assert.equal(queued, 0); assert.equal(resumed, 0);',
    'fs.writeFileSync(file, "{}"); resume({});',
    'assert.equal(queued, 1); assert.equal(resumed, 1);',
  ].join("\n"));
});
