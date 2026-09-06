var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var path = require("path");
var native = require("./helpers/read-only-native-codex");

function toolNames(result) {
  assert.ok(result.requests.length, "the installed binary reaches the local fake provider");
  return result.requests[0].tools.map(function (tool) { return tool.name || tool.type; });
}

test("installed Codex enforces read-only file access and clears native MCP on fresh and resumed execution", async function (t) {
  var f = await native.fixture(t);
  if (!f) return;
  fs.writeFileSync(path.join(f.dir, "evidence.txt"), "READABLE_EVIDENCE_731");
  var writable = await f.run(false, "cat evidence.txt; printf changed > allowed.txt");
  assert.ok(toolNames(writable).some(function (name) { return name.indexOf("sentinel") !== -1; }));
  assert.equal(fs.readFileSync(path.join(f.dir, "allowed.txt"), "utf8"), "changed");
  assert.ok(writable.threadId);
  var unsafeReadOnly = await f.run(false, "", null, "read-only");
  assert.ok(toolNames(unsafeReadOnly).some(function (name) { return name.indexOf("sentinel") !== -1; }));
  for (var resume of [null, unsafeReadOnly.threadId, writable.threadId]) {
    var restricted = await f.run(true, "cat evidence.txt; printf changed > forbidden.txt", resume);
    assert.deepEqual(toolNames(restricted).sort(),
      ["exec_command", "request_user_input", "view_image", "write_stdin"].sort());
    assert.match(JSON.stringify(restricted.requests.slice(1)), /READABLE_EVIDENCE_731/,
      "a denied write is not enough: the same sandboxed command must actually read evidence");
    assert.equal(fs.existsSync(path.join(f.dir, "forbidden.txt")), false);
    assert.match(JSON.stringify(restricted.requests.slice(1)), /[Oo]peration not permitted|[Pp]ermission denied|[Rr]ead-only file system/);
  }
  var ordinary = await f.run(false, "printf still-writable > ordinary-after.txt");
  assert.ok(toolNames(ordinary).some(function (name) { return name.indexOf("sentinel") !== -1; }));
  assert.equal(fs.readFileSync(path.join(f.dir, "ordinary-after.txt"), "utf8"), "still-writable");
});
