// The contextual decision surface: consequential owner decisions render above
// the selected topic's conversation, anchored to canonical evidence -- never
// in the sidebar. The surface module's import graph reaches app-connection.js
// (the live socket), so like the other topic-surface tests this pins the
// contract in source: what it imports, when it fails closed, where it mounts,
// and what repaints it.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

var surface = read("lib/public/modules/coop-topic-decision-surface.js");

test("the surface composes the two real decision panels, not copies of them", function () {
  assert.match(surface, /import \{ createActionDecisionPanel \} from '\.\/coop-action-decision-panel\.js';/);
  assert.match(surface, /import \{ createTopicDecisionPanel \} from '\.\/sidebar-coop-topic-review\.js';/);
  // One decision, one surface: no local re-implementation of verbs.
  assert.doesNotMatch(surface, /coop-action-decide/);
  assert.doesNotMatch(surface, /accept_done|keep_waiting|request_changes/);
});

test("the surface never imports the navigation module", function () {
  assert.doesNotMatch(surface, /app-projects\.js/);
});

test("task items are matched to the topic by canonical TopicRef only", function () {
  assert.match(surface, /export function topicActionItems\(topic, items\)/);
  assert.match(surface, /topicIdOf\(list\[i\] && list\[i\]\.topicRef\) === wanted/);
  // Never by title or recency.
  assert.doesNotMatch(surface, /\.title ===|updatedAt/);
});

test("the surface fails closed instead of rendering a verbs-only card", function () {
  // No selected topic -> nothing; no panels -> null; empty host is hidden.
  assert.match(surface, /if \(!topic\) return null;/);
  assert.match(surface, /if \(!panels\.length\) return null;/);
  assert.match(surface, /host\.hidden = !surface;/);
});

test("a stale selection is re-resolved against the live projection", function () {
  assert.match(surface, /findGlobalCoopTopic\(topicRef, projectRef\)/);
  assert.match(surface, /isCoopProjectSlug\(store\.get\("currentSlug"\)\)/);
});

test("the surface mounts above the conversation, once", function () {
  assert.match(surface, /getElementById\("messages"\)/);
  assert.match(surface, /insertBefore\(host, messages\)/);
  assert.match(surface, /getElementById\(SURFACE_ID\)/);
});

test("the heading names the topic and is announced as a heading", function () {
  assert.match(surface, /"Your decision \u2014 " \+ canonicalTopicTitle\(topic, "this topic"\)/);
  assert.match(surface, /setAttribute\("role", "heading"\)/);
  assert.match(surface, /setAttribute\("aria-level", "2"\)/);
  assert.match(surface, /setAttribute\("aria-label", "Decisions for "/);
});

test("the surface repaints on every store key it derives from", function () {
  [
    "currentSlug", "activeCoopLens", "activeCoopTopicRef", "activeCoopProjectRef",
    "coopProjectionVersion", "coopActionQueue",
    "coopActionPending", "coopActionError", "coopActionNote", "coopActionDone",
    "coopTopicReviewPending", "coopTopicReviewErrors",
  ].forEach(function (key) {
    assert.match(surface, new RegExp("state\\." + key + " !== previous\\." + key),
      key + " must trigger a repaint");
  });
});

test("the surface is wired into the app by a side-effect import", function () {
  var sessions = read("lib/public/modules/app-messages-sessions.js");
  assert.match(sessions, /import '\.\/coop-topic-decision-surface\.js';/);
});

test("decisions go through the live socket, with the transport injected", function () {
  assert.match(surface, /import \{ sendUserAction \} from '\.\/app-connection\.js';/);
  assert.match(surface, /send: sendUserAction/);
});

test("the sidebar injects topic navigation into the immediate action index", function () {
  var topics = read("lib/public/modules/sidebar-coop-topics.js");
  assert.match(topics, /openTopic: function \(item\)/);
  assert.match(topics, /findGlobalCoopTopic\(item\.topicRef, item\.projectRef\)/);
  assert.match(topics, /if \(!found\) return false;/,
    "a missing topic must fall through to the session destination");
});

test("the surface styles live with the conversation, desktop and phone alike", function () {
  var css = read("lib/public/css/messages.css");
  assert.match(css, /\.coop-topic-decision \{/);
  assert.match(css, /\.coop-topic-decision-heading/);
  assert.match(css, /\.coop-action-detail \{/);
  assert.match(css, /\.coop-topic-review-panel/);
  assert.match(css, /\.coop-action-state-withheld/);
  // And the sidebar no longer carries the decision styles it lost.
  var sidebar = read("lib/public/css/sidebar.css");
  assert.doesNotMatch(sidebar, /coop-action-detail/);
  assert.doesNotMatch(sidebar, /coop-topic-review/);
  var mobile = read("lib/public/css/mobile-nav.css");
  assert.doesNotMatch(mobile, /mobile-coop-action-detail/);
  assert.doesNotMatch(mobile, /mobile-coop-topic-review/);
});

test("the server stamps each action item with its canonical topic link", function () {
  var queue = read("lib/coop-action-queue.js");
  assert.match(queue, /topicRef: topicRefOf\(task\)/);
  assert.match(queue, /function topicRefOf\(task\)/);
  // Dedup prefers the copy the owner can navigate from.
  assert.match(queue, /item\.topicRef && !seen\.topicRef/);
});
