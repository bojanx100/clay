// A raw control byte in a source file makes git classify the whole file as
// binary and makes `grep -I` skip it silently. That is how a NUL used as a key
// separator hid all 2168 lines of lib/server.js from every text search until
// 63d618de66, and the same slip has been made twice since -- once in a new
// module, once in the DIAGNOSTICS entry documenting the original bug.
//
// The escapes (\u0000, \u001f, \u007f, ...) are byte-identical at runtime, so
// there is never a reason to embed the raw byte. Tab, newline and carriage
// return are the only control characters a text file may contain.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var spawnSync = require("child_process").spawnSync;

var ALLOWED = { 9: true, 10: true, 13: true };
var TEXT_EXTENSIONS = { ".js": true, ".mjs": true, ".cjs": true, ".json": true,
  ".md": true, ".css": true, ".html": true, ".yml": true, ".yaml": true };

function trackedTextFiles(root) {
  var listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (listed.status !== 0) return null;
  return String(listed.stdout || "").split("\u0000").filter(function (name) {
    return name && TEXT_EXTENSIONS[path.extname(name).toLowerCase()] === true;
  });
}

test("no tracked text file contains a raw control byte", function () {
  var root = path.join(__dirname, "..");
  var files = trackedTextFiles(root);
  if (!files) {
    // Not a git checkout (packed tarball, vendored copy): nothing to assert.
    return;
  }
  assert.ok(files.length > 100, "expected the tracked file list to be populated");
  var offenders = [];
  files.forEach(function (name) {
    var buffer;
    try { buffer = fs.readFileSync(path.join(root, name)); } catch (e) { return; }
    for (var i = 0; i < buffer.length; i++) {
      var byte = buffer[i];
      if ((byte < 32 && !ALLOWED[byte]) || byte === 127) {
        var line = buffer.slice(0, i).toString("utf8").split("\n").length;
        offenders.push(name + ":" + line + " byte 0x" +
          byte.toString(16).padStart(2, "0"));
        break; // one report per file is enough to fail and locate it
      }
    }
  });
  assert.deepEqual(offenders, [],
    "raw control bytes make a file binary to git and invisible to grep -I; " +
    "use the equivalent backslash-u escape instead");
});
