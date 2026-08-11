var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

test("reply quotes preserve lines and cap long transcript messages", async function () {
  var reply = await import(moduleUrl("message-reply.js") + "?quote-test=" + Date.now());
  assert.equal(reply.buildReplyQuote("  first\nsecond  "), "> first\n> second");
  assert.equal(reply.buildReplyQuote("   "), "");
  var quote = reply.buildReplyQuote("x".repeat(700));
  assert.equal(quote.length, 603);
  assert.equal(quote.endsWith("\u2026"), true);
});

test("user replies identify attachment-only messages", async function () {
  var reply = await import(moduleUrl("message-reply.js") + "?attachment-test=" + Date.now());
  assert.equal(reply.userMessageReplyText("hello", [], []), "hello");
  assert.equal(reply.userMessageReplyText("", [{}], []), "[1 image]");
  assert.equal(reply.userMessageReplyText("note", [{}, {}], ["paste"]), "[2 images]\n[1 pasted item]\nnote");
});

test("writing a reply keeps the existing draft and moves focus after it", async function () {
  var reply = await import(moduleUrl("message-reply.js") + "?draft-test=" + Date.now());
  var events = [];
  var input = {
    value: "existing draft",
    selectionStart: 0,
    selectionEnd: 0,
    dispatchEvent: function (event) { events.push(event); },
    focus: function () { this.focused = true; },
  };
  assert.equal(reply.writeReplyDraft(input, "message to quote"), true);
  assert.equal(input.value, "> message to quote\n\nexisting draft");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "input");
  assert.equal(input.focused, true);
  assert.equal(input.selectionStart, input.value.length);
  assert.equal(input.selectionEnd, input.value.length);
});

test("assistant and user message actions use the same reply composer", function () {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "app-rendering.js"), "utf8");
  assert.match(source, /import \{ replyToMessage, userMessageReplyText \} from '\.\/message-reply\.js';/);
  assert.match(source, /msg-assistant-reply-btn[\s\S]*replyToMessage\(msgEl, rawText\)/);
  assert.match(source, /msg-action-reply[\s\S]*replyToMessage\(div, userMessageReplyText\(text, images, pastes\)\)/);
  assert.match(source, /msg-action-reply[^>]*aria-label="Reply to this message"/);
});
