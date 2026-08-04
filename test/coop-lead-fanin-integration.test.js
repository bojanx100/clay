var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");

var processorModule = require("../lib/sdk-message-processor");
var buildFanInEvent = require("../lib/coop-fanin-events").buildFanInEvent;
var attachCoopFanIn = require("../lib/coop-fanin-delivery").attachCoopFanIn;
var attachCoopWatchdog = require("../lib/coop-watchdog-runtime").attachCoopWatchdog;

function createScratchDir(name) {
  var base = path.join(__dirname, ".scratch");
  fs.mkdirSync(base, { recursive: true });
  var dir = path.join(base, name + "-" + process.pid + "-" + Date.now() + "-" +
    Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeProcessor(notifications, pushes) {
  return processorModule.attachMessageProcessor({
    sm: {
      modelsByVendor: {},
      availableModels: [],
      saveSessionFile: function () {},
      broadcastSessionList: function () {},
      sendToSession: function () {},
      sendAndRecord: function (session, obj) {
        session.history.push(obj);
      },
    },
    send: function () {},
    slug: "test",
    isMate: false,
    mateDisplayName: "",
    pushModule: {
      sendPush: function (payload) {
        pushes.push(payload);
      },
    },
    getNotificationsModule: function () {
      return {
        notify: function (type, data) {
          notifications.push({ type: type, data: data });
        },
      };
    },
    getSDK: function () { return null; },
    adapter: { vendor: "codex" },
    cwd: process.cwd(),
    onProcessingChanged: function () {},
    onTurnDone: function () {},
    onAutoTitle: function () {},
    opts: {},
    discoverSkillDirs: function () { return []; },
    mergeSkills: function () { return []; },
    usersModule: {
      getLeadMode: function () { return true; },
    },
  });
}

function baseWorker(taskId, storageId) {
  return {
    localId: storageId === "worker-1" ? 2 : 3,
    storageId: storageId,
    ownerId: "owner-1",
    title: "Worker",
    vendor: "codex",
    coopControlledBy: {
      coopSessionStorageId: "coop-home",
      since: 1,
    },
    orchestrationParent: {
      taskId: taskId,
      sessionId: 1,
      sessionStorageId: "coop-home",
    },
    history: [{ type: "user_message", text: "Do the work", _ts: 1 }],
    blocks: {},
    sentToolResults: {},
    pendingPermissions: {},
    pendingElicitations: {},
    pendingAskUser: {},
    activeTaskToolIds: {},
    taskIdMap: {},
    isProcessing: true,
    responsePreview: "Finished cleanly",
    _turnSawActivity: true,
  };
}

test("lead-controlled descendants suppress owner notifications while fan-in delivery and watchdog fallback converge on Coop", function () {
  var scratch = createScratchDir("coop-fanin-integration");
  var notifications = [];
  var pushes = [];
  try {
    var processor = makeProcessor(notifications, pushes);
    var coopSession = {
      localId: 1,
      storageId: "coop-home",
      coopHome: true,
      pendingCoordinatorUpdates: [],
      orchestrationTasks: [{
        taskId: "task-1",
        status: "completed",
        workerSessionId: 2,
        workerStorageId: "worker-1",
        updatedAt: 10,
        resultSummary: "Finished cleanly",
      }, {
        taskId: "task-2",
        status: "needs_input",
        workerSessionId: 3,
        workerStorageId: "worker-2",
        updatedAt: 20,
        resultSummary: "Need a decision",
      }],
      orchestrationEvents: [{
        type: "task_status_changed",
        taskId: "task-1",
        at: 10,
        data: { to: "completed" },
      }, {
        type: "task_status_changed",
        taskId: "task-2",
        at: 20,
        data: { to: "needs_input" },
      }],
    };
    var worker1 = baseWorker("task-1", "worker-1");
    var worker2 = baseWorker("task-2", "worker-2");
    var sm = {
      sessions: new Map([
        [1, coopSession],
        [2, worker1],
        [3, worker2],
      ]),
    };
    var fanIn = attachCoopFanIn({
      sm: sm,
      now: function () { return 30; },
      queueCoordinatorUpdate: function (session, text) {
        session.pendingCoordinatorUpdates.push({ text: text, queuedAt: 30 });
      },
      deliveryFile: path.join(scratch, "coop-fanin-delivery.json"),
    });
    var completedEvent = buildFanInEvent(worker1, {
      taskId: "task-1",
      status: "completed",
      updatedAt: 10,
      statusTransitionAt: 10,
      resultSummary: "Finished cleanly",
    }, {
      status: "completed",
      occurredAt: 10,
      summary: "Finished cleanly",
    });
    var watchdog = attachCoopWatchdog({
      sm: sm,
      usersModule: {
        getLeadMode: function () { return true; },
      },
      fanInDelivery: fanIn,
      now: function () { return 40; },
      setInterval: function () { return { id: "watchdog" }; },
      clearInterval: function () {},
    });

    fanIn.deliverEvent(completedEvent);
    processor.processSDKMessage(worker1, {
      yokeType: "result",
      cost: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      modelUsage: { "gpt-5.5": { contextWindow: null } },
      sessionId: "provider-session-1",
    });

    assert.deepEqual(notifications, []);
    assert.deepEqual(pushes, []);
    assert.equal(coopSession.pendingCoordinatorUpdates.length, 1);

    var missedBefore = watchdog.tick();
    assert.equal(missedBefore.length, 1);
    assert.equal(coopSession.pendingCoordinatorUpdates.length, 2);
    assert.match(coopSession.pendingCoordinatorUpdates[0].text, /task-1/);
    assert.match(coopSession.pendingCoordinatorUpdates[1].text, /task-2/);

    var missedAfter = watchdog.tick();
    assert.deepEqual(missedAfter, []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
