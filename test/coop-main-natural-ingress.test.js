var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var ingress = require("../lib/coop-topic-ingress");
var userMessage = require("../lib/project-user-message");
var topics = require("../lib/coop-topic-index");
var foreground = require("../lib/project-user-message-coop");
var CLAY = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var OTHER = "51e67388-cea0-52b7-8e01-cde68cae713c";
var COOP = "871a194b-8879-40f7-a1fe-656e48e722af";

function harness(t, projects) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-natural-ingress-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var index = topics.createTopicIndex({ file: path.join(dir, "topics.json") });
  var session = { coopHome: true, storageId: COOP, history: [] };
  var routeContext = {
    topicIndexFor: function () { return index; },
    getProjectList: function () { return projects; },
  };
  return {
    session: session,
    ctx: {
      validateCoopTopicIngress: function (current, msg, ws) {
        return userMessage.validateCoopTopicIngress(routeContext, current, msg, ws);
      },
      sendTo: function (_, message) { throw new Error(JSON.stringify(message)); },
    },
  };
}

[
  "Fix the sidebar in Clay. Do not push.",
  "Fix the sidebar in Clay and explain the result",
  "Fix the sidebar in Clay, but keep the public API unchanged.",
  "Fix the sidebar in Clay; preserve existing project behavior.",
].forEach(function (text) {
  test("Main preserves the full constraint-bearing instruction: " + text, function (t) {
    var h = harness(t, [{ projectId: CLAY, slug: "clay", title: "Clay" }]);
    var message = { text: text, coopComposerScope: "main" };
    assert.equal(ingress.prepareIngress(h.ctx, {}, message, h.session), true);
    assert.equal(message.text, text);
    assert.deepEqual(message.coopProjectRef, { projectId: CLAY });
    assert.deepEqual(message.coopImplementationDecision, { intent: "fix", projectName: "Clay" });
    var prepared = foreground.attachCoopForegroundIngress({}).applyText(
      { coopIngress: { coop: true } }, message, text);
    assert.ok(prepared.includes(text));
  });
});

[[], [{ projectId: CLAY, slug: "clay", title: "Clay" },
  { projectId: OTHER, slug: "clay", title: "Clay" }]].forEach(function (projects) {
  test("unresolved Main routing reaches Coop without an implementation grant: " + projects.length, function (t) {
    var h = harness(t, projects);
    var text = "Fix the sidebar in Clay. Do not push.";
    var message = { text: text, coopComposerScope: "main" };
    assert.equal(ingress.prepareIngress(h.ctx, {}, message, h.session), true);
    assert.equal(message.text, text);
    assert.equal(message.coopClassification, "conversational");
    assert.equal(message.coopImplementationDecision, null);
    assert.equal(message.coopProjectRef, undefined);
    assert.equal(message.coopTopicRef, undefined);
    assert.equal(message.coopRouteAttention, "project_target_unavailable");
    var prepared = foreground.attachCoopForegroundIngress({}).applyText(
      { coopIngress: { coop: true } }, message, text);
    assert.ok(prepared.includes(text));
    assert.match(prepared, /Clarify the intended project/);
  });
});
