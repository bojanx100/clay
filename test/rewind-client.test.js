var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

test("chat-only rewind cannot be changed into a file operation", async function () {
  var rewind = await import(moduleUrl("rewind.js") + "?chat-only-test=" + Date.now());

  assert.equal(rewind.resolveRewindMode(true, "both"), "chat");
  assert.equal(rewind.resolveRewindMode(true, "files"), "chat");
  assert.equal(rewind.resolveRewindMode(false, "files"), "files");
  assert.equal(rewind.resolveRewindMode(false, ""), "both");
});
