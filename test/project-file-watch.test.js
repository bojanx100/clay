var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var attachFileWatch = require("../lib/project-file-watch").attachFileWatch;

function waitFor(check, timeoutMs) {
  var started = Date.now();
  return new Promise(function (resolve, reject) {
    function poll() {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for file watcher event"));
        return;
      }
      setTimeout(poll, 20);
    }
    poll();
  });
}

function createFixture(t) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-file-watch-"));
  var messages = new Map();
  var watcher = attachFileWatch({
    cwd: cwd,
    send: function () {},
    sendTo: function (client, message) {
      var list = messages.get(client) || [];
      list.push(message);
      messages.set(client, list);
    },
    safePath: function (root, relPath) {
      var resolved = path.resolve(root, relPath);
      if (resolved !== root && resolved.indexOf(root + path.sep) !== 0) return null;
      return resolved;
    },
    BINARY_EXTS: new Set(),
    FS_MAX_SIZE: 1024 * 1024,
    IGNORED_DIRS: new Set(),
  });
  t.after(function () {
    watcher.stopFileWatch();
    watcher.stopAllDirWatches();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd: cwd, messages: messages, watcher: watcher };
}

function replaceFile(cwd, name, content) {
  var tempPath = path.join(cwd, name + ".tmp");
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, path.join(cwd, name));
}

test("file watch survives repeated atomic replacements", async function (t) {
  var fixture = createFixture(t);
  var client = {};
  fs.writeFileSync(path.join(fixture.cwd, "document.md"), "one", "utf8");
  fixture.watcher.startFileWatch(client, "document.md");

  replaceFile(fixture.cwd, "document.md", "two");
  await waitFor(function () {
    return (fixture.messages.get(client) || []).some(function (message) {
      return message.content === "two";
    });
  }, 3000);

  replaceFile(fixture.cwd, "document.md", "three");
  await waitFor(function () {
    return (fixture.messages.get(client) || []).some(function (message) {
      return message.content === "three";
    });
  }, 3000);
});

test("file watches remain isolated per browser client", async function (t) {
  var fixture = createFixture(t);
  var firstClient = {};
  var secondClient = {};
  fs.writeFileSync(path.join(fixture.cwd, "first.md"), "first", "utf8");
  fs.writeFileSync(path.join(fixture.cwd, "second.md"), "second", "utf8");
  fixture.watcher.startFileWatch(firstClient, "first.md");
  fixture.watcher.startFileWatch(secondClient, "second.md");

  fs.writeFileSync(path.join(fixture.cwd, "first.md"), "first updated", "utf8");
  fs.writeFileSync(path.join(fixture.cwd, "second.md"), "second updated", "utf8");
  await waitFor(function () {
    return (fixture.messages.get(firstClient) || []).length > 0 &&
      (fixture.messages.get(secondClient) || []).length > 0;
  }, 3000);

  assert.deepStrictEqual((fixture.messages.get(firstClient) || []).map(function (message) {
    return message.path;
  }), ["first.md"]);
  assert.deepStrictEqual((fixture.messages.get(secondClient) || []).map(function (message) {
    return message.path;
  }), ["second.md"]);
});
