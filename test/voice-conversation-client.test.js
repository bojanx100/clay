var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var root = path.join(__dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

test("ordinary sessions and coordinators hide both dedicated Voice controls", function () {
  var voice = read("lib/public/modules/voice-conversation.js");
  var css = read("lib/public/css/stt.css");

  assert.match(voice, /function selectedCanonicalCoopScope\(\)/);
  assert.match(voice, /return isSafeVoiceConversationRouting\(captureVoiceConversationRouting\(\)\)/);
  assert.match(voice, /var shouldShow = selectedCanonicalCoopScope\(\);/);
  assert.match(voice, /refs\.button\.classList\.toggle\("hidden", !shouldShow\)/);
  assert.match(voice, /refs\.panel\.classList\.toggle\("hidden", !shouldShow \|\| !panelOpen\)/);
  assert.match(css, /#voice-conversation-btn\.hidden,\s*\.voice-conversation-panel\.hidden\s*\{\s*display:\s*none;\s*\}/);
});

test("canonical Coop exposes a named Voice trigger without a standalone Voice Thread", function () {
  var voice = read("lib/public/modules/voice-conversation.js");
  var controller = read("lib/public/modules/voice-conversation-controller.js");

  assert.match(voice, /captureVoiceConversationRouting, isSafeVoiceConversationRouting/);
  assert.match(voice, /if \(!isSafeVoiceConversationRouting\(routing\)\)/);
  assert.doesNotMatch(voice, /VOICE_THREAD_ID|recovery-voice-ingresses-360-362|Voice Thread/);
  assert.doesNotMatch(controller, /createSession|staffWork|delegate_task/);
  assert.match(voice, /aria-label", "Open Voice conversation"/);
  assert.match(voice, /button\.title = "Voice conversation"/);
  assert.match(voice, /panelOpen = !panelOpen;\s*renderVisibility\(\)/);
  assert.match(voice, /<span class="voice-conversation-title">Voice conversation<\/span>/);
});

test("Voice panel stays inside the centered composer with compact desktop and mobile controls", function () {
  var voice = read("lib/public/modules/voice-conversation.js");
  var css = read("lib/public/css/stt.css");

  assert.match(voice, /inputWrapper\.insertBefore\(panel, inputRow\)/);
  assert.doesNotMatch(voice, /inputArea\.insertBefore\(panel, inputWrapper\)/);
  assert.match(css, /\.voice-conversation-panel\s*\{[^}]*width:\s*100%;[^}]*margin:\s*0 0 8px;/s);
  assert.match(css, /@media \(max-width: 768px\)\s*\{[^}]*\.voice-conversation-panel \{ margin-bottom: 7px; padding: 9px; \}[^}]*\.voice-conversation-actions \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/s);
});

test("dedicated Voice UI retains conversation behavior wiring", function () {
  var voice = read("lib/public/modules/voice-conversation.js");
  var app = read("lib/public/app.js");
  var input = read("lib/public/modules/input.js");
  var messages = read("lib/public/modules/app-messages.js");

  assert.match(voice, /aria-live="polite"/);
  assert.match(voice, /Stop speech/);
  assert.match(voice, /Cancel turn/);
  assert.match(voice, /devicechange/);
  assert.match(app, /initVoiceConversation\(\)/);
  assert.match(input, /sendVoiceConversationMessage/);
  assert.match(input, /takeVoiceConversationIngress/);
  assert.match(messages, /observeVoiceConversationMessage/);
});
