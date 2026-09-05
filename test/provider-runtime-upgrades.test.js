var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var appServer = require("../lib/yoke/codex-app-server");

test("CLAY_CODEX_PATH selects an existing Codex binary", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-path-"));
  var binary = path.join(dir, "codex");
  fs.writeFileSync(binary, "test");
  var previous = process.env.CLAY_CODEX_PATH;
  process.env.CLAY_CODEX_PATH = binary;
  t.after(function () {
    if (previous === undefined) delete process.env.CLAY_CODEX_PATH;
    else process.env.CLAY_CODEX_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(appServer.findCodexPath(), binary);
});

test("Claude declares per-task Stop behavior on both runtime paths", function () {
  var source = fs.readFileSync(path.join(__dirname, "../lib/yoke/adapters/claude.js"), "utf8");
  assert.match(source, /var PER_TASK_STOP_AFFORDANCE = true;/);
  assert.match(source, /sdkOptions\.perTaskStopAffordance = PER_TASK_STOP_AFFORDANCE;/);
  assert.match(source, /queryOptions\.perTaskStopAffordance = PER_TASK_STOP_AFFORDANCE;/);
});

test("provider runtime dependencies match the vetted Canonical versions", function () {
  var manifest = require("../package.json");
  var lock = require("../package-lock.json");
  assert.equal(manifest.dependencies["@anthropic-ai/claude-agent-sdk"], "^0.3.258");
  assert.equal(manifest.optionalDependencies["@openai/codex"], "0.153.4");
  assert.equal(lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version, "0.3.258");
  assert.equal(lock.packages["node_modules/@openai/codex"].version, "0.153.4");
});
