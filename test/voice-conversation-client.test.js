var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var root = path.join(__dirname, "..");

test("dedicated Voice UI is wired below the canonical Voice Thread and stays accessible on mobile", function () {
  var voice = fs.readFileSync(path.join(root, "lib", "public", "modules", "voice-conversation.js"), "utf8");
  var app = fs.readFileSync(path.join(root, "lib", "public", "app.js"), "utf8");
  var input = fs.readFileSync(path.join(root, "lib", "public", "modules", "input.js"), "utf8");
  var messages = fs.readFileSync(path.join(root, "lib", "public", "modules", "app-messages.js"), "utf8");
  var css = fs.readFileSync(path.join(root, "lib", "public", "css", "stt.css"), "utf8");

  assert.match(voice, /VOICE_THREAD_ID = "recovery-voice-ingresses-360-362"/);
  assert.match(voice, /selectedVoiceThread\(\)/);
  assert.match(voice, /aria-live="polite"/);
  assert.match(voice, /Stop speech/);
  assert.match(voice, /Cancel turn/);
  assert.match(voice, /devicechange/);
  assert.match(app, /initVoiceConversation\(\)/);
  assert.match(input, /sendVoiceConversationMessage/);
  assert.match(input, /takeVoiceConversationIngress/);
  assert.match(messages, /observeVoiceConversationMessage/);
  assert.match(css, /\.voice-conversation-panel/);
  assert.match(css, /@media \(max-width: 768px\)/);
});
