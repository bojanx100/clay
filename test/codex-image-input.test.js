var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var codexAdapter = require("../lib/yoke/adapters/codex");

var ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

function createQueryServer() {
  var handler = null;
  var turnStartResolve;
  var turnStart = new Promise(function(resolve) { turnStartResolve = resolve; });
  return {
    started: true,
    turnStart: turnStart,
    subscribe: function(nextHandler) {
      handler = nextHandler;
      return function() { handler = null; };
    },
    send: function(method, params) {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "image-thread" } });
      if (method === "turn/start") {
        turnStartResolve(params);
        setImmediate(function() {
          if (!handler) return;
          handler({
            method: "turn/completed",
            params: {
              threadId: params.threadId,
              turn: { id: "image-turn", status: "completed", items: [] },
            },
          });
        });
      }
      return Promise.resolve({});
    },
  };
}

async function sendImageMessage(text, images) {
  var server = createQueryServer();
  var handle = codexAdapter.contractTestKit.createQueryHandle(server, {
    cwd: process.cwd(),
    model: "gpt-5.6-terra",
    abortController: new AbortController(),
  });
  handle.pushMessage(text, images);
  var params = await server.turnStart;
  handle.close();
  return params.input;
}

test("Codex forwards a persisted PNG as localImage before the owner text", async function(t) {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-image-input-"));
  var imagePath = path.join(directory, "owner.png");
  fs.writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG, "base64"));
  t.after(function() { fs.rmSync(directory, { recursive: true, force: true }); });

  var input = await sendImageMessage("Inspect the attached image", [{
    mediaType: "image/png",
    savedPath: imagePath,
    data: ONE_PIXEL_PNG,
  }]);

  assert.deepEqual(input, [
    { type: "localImage", path: imagePath },
    { type: "text", text: "Inspect the attached image" },
  ]);
});

test("Codex preserves a corrupt attachment with a precise text fallback", async function(t) {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-image-input-"));
  var imagePath = path.join(directory, "corrupt.png");
  fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  t.after(function() { fs.rmSync(directory, { recursive: true, force: true }); });

  var input = await sendImageMessage("Inspect the attached image", [{
    mediaType: "image/png",
    savedPath: imagePath,
  }]);

  assert.deepEqual(input, [{
    type: "text",
    text: "Inspect the attached image\n\n[Clay preserved image attachment 1 but did not send it to Codex: invalid PNG data. The original file remains at " + imagePath + ".]",
  }]);
});
