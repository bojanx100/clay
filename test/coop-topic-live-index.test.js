var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var createTopicIndex = require("../lib/coop-topic-index").createTopicIndex;
var globalCoopProjection = require("../lib/global-coop-projection");
var liveTopicIndex = require("../lib/coop-topic-live-index");

function project(projectId, slug, sessions) {
  return {
    projectId: projectId,
    slug: slug,
    title: slug,
    sm: { sessions: new Map(sessions.map(function (session) { return [session.localId, session]; })) },
  };
}

test("a completed All turn advances the durable index and refreshes only its connected owner", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-topic-live-"));
  try {
    var index = createTopicIndex({ file: path.join(dir, "lead", "topics.json"), now: function () { return 10; } });
    var home = {
      localId: 1,
      storageId: "canonical-live-topic-home",
      coopHome: true,
      ownerId: "owner",
      history: [
        { type: "user_message", text: "An earlier unmatched conversation", from: "owner", fromName: "Admin", clientMessageId: "cm-fixture" },
        { type: "delta_replace", text: "Earlier final answer" },
        { type: "done" },
      ],
    };
    var lead = project("system-lead", "lead", [home]);
    var clay = project("5332aafc-31e7-5cb1-ba96-c8d90e78260e", "clay", []);
    var contexts = [lead, clay];
    assert.equal(globalCoopProjection.advanceCanonicalCoopTopics({
      projects: contexts, coopTopicIndex: index,
    }, home).ok, true);

    home.history.push(
      { type: "user_message", text: "Codex authentication from All without a TopicRef", from: "owner", fromName: "Admin", clientMessageId: "cm-fixture" },
      { type: "delta_replace", text: "The final authentication response" },
      { type: "done" }
    );
    var owner = { readyState: 1, _clayUser: { id: "owner" } };
    var other = { readyState: 1, _clayUser: { id: "other" } };
    var sent = [];
    var refreshed = liveTopicIndex.refreshCanonicalCoopTopics({
      session: home,
      multiUser: true,
      advance: function (session) {
        return globalCoopProjection.advanceCanonicalCoopTopics({
          projects: contexts, coopTopicIndex: index,
        }, session);
      },
      forEachClient: function (visit) { visit(owner); visit(other); },
      projectionFor: function (ws) {
        return globalCoopProjection.buildGlobalCoopProjection({
          projects: contexts, actor: ws, coopTopicIndex: index,
        });
      },
      sendTo: function (ws, projection) { sent.push({ ws: ws, projection: projection }); },
    });

    assert.deepEqual(refreshed, { ok: true, changed: true, sent: 1 });
    assert.equal(sent[0].ws, owner);
    var auth = index.resolve({ topicId: "codex-authentication" }).topic;
    assert.deepEqual(auth.turnRefs.at(-1), {
      projectId: "system-lead", sessionStorageId: "canonical-live-topic-home", startEventIndex: 3, endEventIndex: 5,
    });
    assert.deepEqual(auth.eventRefs.at(-1), {
      projectId: "system-lead", sessionStorageId: "canonical-live-topic-home", eventIndex: 3,
    });
    assert.equal(fs.readFileSync(index.file, "utf8").includes("authentication from All"), false);
    assert.equal(JSON.stringify(sent[0].projection).includes("authentication from All"), false);
    var projectedAuth = sent[0].projection.topicProjection.groups.reduce(function (found, group) {
      return found || group.topics.find(function (topic) { return topic.topicRef.topicId === "codex-authentication"; });
    }, null);
    assert.deepEqual(projectedAuth.eventRefs, []);
    assert.deepEqual(projectedAuth.turnRefs, []);

    assert.deepEqual(liveTopicIndex.refreshCanonicalCoopTopics({
      session: home,
      multiUser: true,
      advance: function (session) {
        return globalCoopProjection.advanceCanonicalCoopTopics({
          projects: contexts, coopTopicIndex: index,
        }, session);
      },
      forEachClient: function (visit) { visit(owner); },
      projectionFor: function () { throw new Error("an idempotent cursor must not refresh"); },
      sendTo: function () {},
    }), { ok: true, code: null, changed: false, sent: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
