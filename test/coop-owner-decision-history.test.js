var test = require("node:test");
var assert = require("node:assert/strict");
var sessionHistory = require("../lib/sessions-history");
var coopSessionHistory = require("../lib/coop-session-history");
var topicConnection = require("../lib/coop-topic-connection");
var decisionStaging = require("../lib/coop-owner-decision-staging");

var SOURCE = "6ed5d9a9-278f-4c60-8e45-bc3a868356b5";
var SUCCESSOR = "7f0d70d1-418f-4ae0-8ae8-01d7f4b76d1e";
var TOPIC = { topicId: "post-council-plan" };

function scope() {
  return {
    targetProject: { projectId: "5332aafc-31e7-5cb1-ba96-c8d90e78260e" },
    portfolioTaskId: "coherent-role-plan",
    bindingRevision: 1,
    planRevision: 1,
    planDigest: "0123456789abcdef0123456789abcdef",
    coopTopicRef: TOPIC,
  };
}

test("a staged post-Council decision response remains ordered and unique after compaction", function () {
  var source = {
    storageId: SOURCE,
    coopHome: true,
    isProcessing: true,
    history: [{ type: "user_message", text: "↻ Lead tick", synthetic: true, autoAction: true }, {
      type: "delta",
      text: "One genuine owner decision remains: accept or change the Council-derived defaults.",
    }, {
      type: "done", code: 0,
    }, {
      type: "user_message", text: "↻ Lead tick", synthetic: true, autoAction: true }],
  };
  var staged = decisionStaging.newDecision(scope(), source);
  source.history.push({
    type: "delta",
    text: "One genuine owner decision remains: accept or change the Council-derived defaults.",
  }, {
    type: "message_uuid", uuid: "codex-decision", messageType: "assistant",
  }, {
    type: "result", usage: { input_tokens: 100 },
  }, {
    type: "done", code: 0,
  });

  // Settled task metadata moves to the continuation on compaction; the source
  // transcript stays immutable and hidden. This is the authoritative seam that
  // previously had no typed decision-to-response link.
  staged.status = "answered";
  staged.state = "answered";
  staged.answeredAt = 20;
  var successor = {
    storageId: SUCCESSOR,
    coopHome: true,
    compactedFromStorageId: SOURCE,
    history: [{ type: "info", text: "Compacted continuation" }],
    orchestrationTasks: [{
      taskId: "decision-task",
      clientRef: "owner-decision:" + staged.decisionRef,
      status: "completed",
      ownerDecision: staged,
    }],
  };
  var sessions = new Map([[1, source], [2, successor]]);
  var view = coopSessionHistory.forSession(successor, sessions);
  var indexes = topicConnection.boundedMembershipIndexes({ topicRef: TOPIC,
    eventRefs: [], turnRefs: [] }, successor, view);
  assert.deepEqual(indexes, [4],
    "the explicitly linked assistant decision survives an earlier identical tick delta");

  var sent = [];
  var api = sessionHistory.attachSessionHistory({
    send: function (message) { sent.push(message); },
    sessions: sessions,
    isMeaninglessUnknownError: function () { return false; },
  });
  api.replayHistory(successor, undefined, undefined, null, {
    historyView: view,
    eventIndexes: indexes,
    scope: "topic",
    topicRef: TOPIC,
    annotateHistoryIndex: true,
  });
  var decisionMessages = sent.filter(function (message) {
    return message.type === "delta" && message.text.indexOf("One genuine owner decision") !== -1;
  });
  assert.equal(decisionMessages.length, 1, "the linked response is replayed exactly once");
  assert.equal(decisionMessages[0]._historyIndex, 4, "the replay keeps canonical predecessor order");
});
