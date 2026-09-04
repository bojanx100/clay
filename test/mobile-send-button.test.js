var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("touch composers keep the send arrow while a response is active", function () {
  var faviconSource = readSource("lib/public/modules/app-favicon.js");
  var inputSource = readSource("lib/public/modules/input.js");

  assert.match(faviconSource, /var isTouchComposer = "ontouchstart" in window;/);
  assert.match(faviconSource, /if \(mode === "stop" && !isTouchComposer\)/);
  assert.match(
    inputSource,
    /if \(ctx\.sendBtn\.classList\.contains\("stop"\) && ctx\.processing && !hasSendableContent\(\)\)/
  );
});
