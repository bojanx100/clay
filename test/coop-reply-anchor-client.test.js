var fs = require("node:fs");
var path = require("node:path");
var test = require("node:test");
var assert = require("node:assert/strict");
var pathToFileURL = require("node:url").pathToFileURL;

var serverAnchor = require("../lib/coop-topic-reply-anchor");

// The client half of topic reply threading.
//
// The server stamps `coopTopicAnchor` on the owner's message and the browser
// renders it as "Reply in <topic>" so the message reads as part of its thread
// instead of unrelated general-chat tail content. The client cannot simply
// trust that field: the same transcript renders messages from every topic and
// from general chat, so a client that renders whatever topic an anchor names --
// without checking the message's OWN topic ref -- would happily attribute one
// owner conversation to another topic. Both halves therefore apply the same
// fail-closed gates, and this suite pins them to each other: if the server
// normalizer and the client normalizer ever disagree about what a valid anchor
// is, one of them is rendering or reasoning about a lie.
//
// Rendering itself is asserted against module and stylesheet source, matching
// how the other Coop client suites in this repo test DOM-dependent code.

function clientModulePath() {
  return path.join(__dirname, "..", "lib", "public", "modules", "coop-reply-anchor.js");
}

function loadClientAnchor() {
  return import(pathToFileURL(clientModulePath()).href + "?reply-anchor-test=" + Date.now() + Math.random());
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
}

// A well-formed anchor, exactly as the server emits it.
function validAnchor(extra) {
  return Object.assign({
    version: serverAnchor.ANCHOR_VERSION,
    topicId: "topic-a",
    sessionStorageId: "canonical-coop-home",
    eventIndex: 6,
    type: "user_message",
    ts: 1700,
    clientMessageId: "cm-1700",
  }, extra || {});
}

function message(anchor, topicId) {
  return {
    type: "user_message", text: "a follow-up in the topic",
    coopTopicRef: topicId ? { topicId: topicId } : null,
    coopTopicAnchor: anchor,
  };
}

// --- the two normalizers must agree, value for value -------------------------

test("the client normalizer accepts exactly what the server normalizer accepts", async function () {
  var client = await loadClientAnchor();
  var accepted = [
    validAnchor(),
    validAnchor({ eventIndex: 0 }),
    validAnchor({ ts: null, clientMessageId: "" }),
  ];
  for (var i = 0; i < accepted.length; i++) {
    var fromServer = serverAnchor.normalizeReplyAnchor(accepted[i]);
    var fromClient = client.normalizeReplyAnchor(accepted[i]);
    assert.ok(fromServer, "server accepts candidate " + i);
    assert.deepEqual(fromClient, fromServer,
      "client and server must normalize candidate " + i + " to the identical shape");
  }
});

test("the client normalizer rejects exactly what the server normalizer rejects", async function () {
  var client = await loadClientAnchor();
  var rejected = [
    null,
    undefined,
    "topic-a",
    [validAnchor()],
    validAnchor({ version: 2 }),
    validAnchor({ version: undefined }),
    validAnchor({ topicId: "" }),
    validAnchor({ topicId: "   " }),
    validAnchor({ sessionStorageId: "" }),
    validAnchor({ eventIndex: -1 }),
    validAnchor({ eventIndex: 1.5 }),
    validAnchor({ eventIndex: "6" }),
  ];
  for (var i = 0; i < rejected.length; i++) {
    assert.equal(serverAnchor.normalizeReplyAnchor(rejected[i]), null,
      "server must reject candidate " + i);
    assert.equal(client.normalizeReplyAnchor(rejected[i]), null,
      "client must reject the same candidate " + i + " -- a client that is more permissive renders an anchor the server would not honour");
  }
});

// --- cross-topic attribution is refused on the client too --------------------

test("replyAnchorFor refuses an anchor that names a different topic than the message itself", async function () {
  var client = await loadClientAnchor();
  // The anchor claims Topic A while the message was sent in Topic B. Rendering
  // "Reply in Topic A" here would attach one owner conversation to another
  // topic in the transcript -- the exact misattribution the anchor exists to
  // prevent -- so it must be refused rather than re-pointed at Topic B.
  var crossed = message(validAnchor({ topicId: "topic-a" }), "topic-b");
  assert.equal(client.replyAnchorFor(crossed), null,
    "a topicId mismatch must yield no anchor at all");
  assert.equal(serverAnchor.anchorForItem(crossed, null), null,
    "the server refuses the same record, so both surfaces agree");
});

test("replyAnchorFor returns the anchor when the message and the anchor name the same topic", async function () {
  var client = await loadClientAnchor();
  var matched = message(validAnchor({ topicId: "topic-a" }), "topic-a");
  var anchor = client.replyAnchorFor(matched);
  assert.ok(anchor, "a same-topic anchor is renderable");
  assert.equal(anchor.eventIndex, 6);
  assert.equal(anchor.topicId, "topic-a");
  assert.deepEqual(anchor, serverAnchor.anchorForItem(matched, null),
    "client and server resolve the same record to the same anchor");
});

test("a general-chat message with no topic and no anchor is left completely alone", async function () {
  var client = await loadClientAnchor();
  assert.equal(client.replyAnchorFor({ type: "user_message", text: "plain general chat" }), null,
    "no anchor field means no chip");
  assert.equal(client.replyAnchorFor(message(null, "topic-a")), null,
    "a topic ref without an anchor still means no chip -- the chip names a reply target, not a lens");
  assert.equal(client.replyAnchorFor(message(validAnchor(), null)), null,
    "an anchor on a record that claims no topic cannot be trusted and is dropped");
  assert.equal(client.replyAnchorFor(null), null);
  assert.equal(client.replyAnchorFor("not an object"), null);
});

// --- rendering contract ------------------------------------------------------

test("the chip is rendered from the message's own topic and never from raw HTML", function () {
  var source = readSource("lib/public/modules/coop-reply-anchor.js");
  assert.match(source, /label\.textContent = chipLabel\(anchor\)/,
    "the topic title must be set as text, never interpolated into innerHTML");
  assert.match(source, /findGlobalCoopTopic\(\{ topicId: anchor\.topicId \}\)/,
    "the title is resolved from the projection by the anchor's own topic id");
  assert.match(source, /var FALLBACK_TITLE = "Reply in topic"/,
    "an unknown topic still renders an honest chip rather than an empty one");
  assert.match(source, /el\.querySelector\(".coop-reply-anchor"\)/,
    "applying the chip twice to the same element must not duplicate it");
});

test("the chip only becomes interactive when its target is actually on screen", function () {
  var source = readSource("lib/public/modules/coop-reply-anchor.js");
  assert.match(source, /data-history-index="' \+ anchor\.eventIndex \+ '"/,
    "the jump target is located by the canonical history index the anchor names");
  assert.match(source, /if \(target\) wireJump\(chip, target\)/,
    "no target means a static chip -- a button that silently does nothing is worse than plain text");
  assert.match(source, /setAttribute\("role", "button"\)/);
  assert.match(source, /setAttribute\("tabindex", "0"\)/);
  assert.match(source, /e\.key !== "Enter" && e\.key !== " "/,
    "a chip reachable by keyboard must be activatable by keyboard");
});

test("client and server pin the same anchor version, so a shape change cannot land on one side only", async function () {
  var client = await loadClientAnchor();
  var source = readSource("lib/public/modules/coop-reply-anchor.js");
  var declared = /var ANCHOR_VERSION = (\d+);/.exec(source);
  assert.ok(declared, "the client declares an anchor version");
  assert.equal(Number(declared[1]), serverAnchor.ANCHOR_VERSION,
    "client ANCHOR_VERSION must track lib/coop-topic-reply-anchor.js");
  // Proven behaviourally as well as by source: an anchor one version ahead is
  // refused, which is what makes a future shape change fail closed instead of
  // being half-honoured by an older client.
  assert.equal(client.normalizeReplyAnchor(validAnchor({ version: serverAnchor.ANCHOR_VERSION + 1 })), null);
});

// --- lens behaviour and desktop/mobile parity --------------------------------

test("the chip is suppressed inside its own topic lens without adding a second lens-hiding rule", function () {
  var css = readSource("lib/public/css/messages.css");
  var clientSource = readSource("lib/public/modules/coop-reply-anchor.js");
  // Naming the topic inside its own lens is redundant, but that suppression
  // must NOT be a lens-scoped `display: none`. Exactly one such rule may exist
  // -- the Main internal-relevance filter -- because a second one erodes the
  // guarantee that the All lens is full fidelity. coop-live-lens-filtering
  // enforces that count; this asserts the chip respects it by construction.
  var hidingRules = css.match(/#messages\[data-coop-lens="[^"]+"\][^{]*\{[^}]*display:\s*none/g) || [];
  assert.equal(hidingRules.length, 1, "only the Main lens may hide anything via CSS");
  assert.match(hidingRules[0], /data-coop-lens="main"/);
  assert.match(clientSource, /if \(anchor\.topicId === activeTopicId\(\)\) return false;/,
    "suppression is decided when the chip is built, from the message's own topic");
  assert.match(css, /\.coop-reply-anchor \{/, "the chip has a base style");
  assert.match(css, /\.coop-reply-anchor\[role="button"\] \{\s*\n?\s*cursor: pointer;/,
    "only an interactive chip advertises itself as clickable");
});

test("the reply chip has no mobile-only branch, so desktop and mobile render identically", function () {
  var css = readSource("lib/public/css/messages.css");
  var clientSource = readSource("lib/public/modules/coop-reply-anchor.js");
  // Coop has one transcript renderer; only the sidebar has a mobile variant.
  // A media query or a mobile- prefixed rule targeting the chip would be a
  // second rendering path and would let the two surfaces disagree.
  assert.equal(/mobile[^\n]*coop-reply-anchor/i.test(css), false,
    "no mobile-prefixed rule may target the reply chip");
  assert.equal(/mobile/i.test(clientSource), false,
    "the chip module must not branch on a mobile flag");
});

test("the live echo and history replay both decorate the message they just created", function () {
  var stream = readSource("lib/public/modules/app-messages-stream.js");
  // Replayed history items arrive as ordinary `user_message` events through the
  // same handler, so decorating there covers both paths with one call site.
  assert.match(stream, /import \{ applyCoopReplyAnchor \} from '\.\/coop-reply-anchor\.js'/);
  var applications = stream.match(/applyCoopReplyAnchor\(/g) || [];
  assert.equal(applications.length, 2,
    "both branches of handleUserMessage (plan content and plain text) must decorate their element");
  var rendering = readSource("lib/public/modules/app-rendering.js");
  assert.match(rendering, /addToMessages\(div\);\n  refreshIcons\(\);\n  forceScrollToBottom\(\);\n  return div;/,
    "addUserMessage must return the element it created, or there is nothing to decorate");
});
