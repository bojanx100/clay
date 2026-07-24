var test = require("node:test");
var assert = require("node:assert");

var streamModule = require("../lib/sdk-bridge-stream");

test("isTransientProviderErrorText flags self-recovering reconnects, not real failures", function () {
  assert.strictEqual(streamModule.isTransientProviderErrorText("Reconnecting... 4/5"), true);
  assert.strictEqual(streamModule.isTransientProviderErrorText("Stream disconnected, reconnecting"), true);
  assert.strictEqual(streamModule.isTransientProviderErrorText("You've hit your usage limit."), false);
  assert.strictEqual(streamModule.isTransientProviderErrorText("Claude process error: boom"), false);
  assert.strictEqual(streamModule.isTransientProviderErrorText(""), false);
  assert.strictEqual(streamModule.isTransientProviderErrorText(null), false);
});
