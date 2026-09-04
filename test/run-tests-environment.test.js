var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var spawnSync = require("child_process").spawnSync;

var testRunner = require("../scripts/run-tests");
var sanitizedTestEnvironment = testRunner.sanitizedTestEnvironment;

test("test runner removes live Coop control flags without mutating its source", function () {
  var source = {
    PATH: "/bin",
    CLAY_COOP_CONTROL_STORE: "1",
    CLAY_COOP_CONTROL_EXECUTIONS: "1",
    CLAY_COOP_CONTROL_RECOVERY: "1",
    CLAY_UNRELATED: "keep",
  };
  var result = sanitizedTestEnvironment(source);

  assert.strictEqual(result.CLAY_COOP_CONTROL_STORE, undefined);
  assert.strictEqual(result.CLAY_COOP_CONTROL_EXECUTIONS, undefined);
  assert.strictEqual(result.CLAY_COOP_CONTROL_RECOVERY, undefined);
  assert.strictEqual(result.CLAY_UNRELATED, "keep");
  assert.strictEqual(source.CLAY_COOP_CONTROL_STORE, "1");
});

test("test runner isolates model catalog writes from the inherited Clay home", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-run-tests-environment-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var liveHome = path.join(dir, "live-home");
  var liveCatalog = path.join(liveHome, "model-catalog.json");
  var testHome = path.join(dir, "test-home");
  fs.mkdirSync(liveHome, { recursive: true });
  fs.mkdirSync(testHome, { recursive: true });
  fs.writeFileSync(liveCatalog, "live-catalog-must-survive");
  var source = Object.assign({}, process.env, {
    CLAY_HOME: liveHome,
    CLAY_MODEL_CATALOG_PATH: liveCatalog,
  });

  var environment = testRunner.isolatedTestEnvironment(source, testHome);
  var script = "require(" + JSON.stringify(path.join(__dirname, "..", "lib", "model-catalog-cache")) +
    ").applyDiscovery('codex', [{ value: 'gpt-test-only' }]);";
  var child = spawnSync(process.execPath, ["-e", script], {
    env: environment,
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.equal(environment.CLAY_HOME, testHome);
  assert.equal(environment.CLAY_MODEL_CATALOG_PATH,
    path.join(testHome, "model-catalog.json"));
  assert.equal(fs.readFileSync(liveCatalog, "utf8"), "live-catalog-must-survive");
  assert.deepEqual(source.CLAY_HOME, liveHome);
});
