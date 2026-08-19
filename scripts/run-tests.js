#!/usr/bin/env node

var fs = require("fs");
var os = require("os");
var path = require("path");
var spawnSync = require("child_process").spawnSync;
var { COOP_CONTROL_ENVIRONMENT } = require("../lib/config");

function sanitizedTestEnvironment(source) {
  var environment = Object.assign({}, source || {});
  var controls = Object.keys(COOP_CONTROL_ENVIRONMENT);
  for (var i = 0; i < controls.length; i++) {
    delete environment[COOP_CONTROL_ENVIRONMENT[controls[i]]];
  }
  return environment;
}

function isolatedTestEnvironment(source, testHome) {
  var environment = sanitizedTestEnvironment(source);
  environment.CLAY_HOME = testHome;
  environment.CLAY_MODEL_CATALOG_PATH = path.join(testHome, "model-catalog.json");
  return environment;
}

// The default pass strips the Coop control flags so a developer's shell cannot
// change the result. That hermetic choice also meant the controlled-execution
// path was never exercised by `npm test`: suites could sit red under control
// while the gate reported green. A second pass runs the control-plane suites
// with the flags on. Matching by name keeps new control-plane suites covered
// automatically instead of silently opting out of the gate.
var CONTROLLED_SUITE_PATTERN = /(coop-control|orchestrator|admission|execution)/;

// This suite asserts the default-off gate itself, so it must observe an
// environment where the control flags are absent.
var CONTROLLED_SUITE_EXCLUSIONS = ["coop-control-store.test.js"];

function isControlledSuite(file) {
  var name = path.basename(file);
  if (CONTROLLED_SUITE_EXCLUSIONS.indexOf(name) !== -1) return false;
  return CONTROLLED_SUITE_PATTERN.test(name);
}

function controlledTestEnvironment(source, testHome) {
  var environment = isolatedTestEnvironment(source, testHome);
  var controls = Object.keys(COOP_CONTROL_ENVIRONMENT);
  for (var i = 0; i < controls.length; i++) {
    environment[COOP_CONTROL_ENVIRONMENT[controls[i]]] = "1";
  }
  return environment;
}

function defaultTestFiles() {
  var testDir = path.join(__dirname, "..", "test");
  return fs.readdirSync(testDir).filter(function (name) {
    return name.slice(-8) === ".test.js";
  }).sort().map(function (name) {
    return path.join(testDir, name);
  });
}

function spawnPass(files, environmentFor) {
  var testHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-test-run-"));
  var result = null;
  try {
    result = spawnSync(process.execPath, ["--test", "--test-force-exit"].concat(files), {
      env: environmentFor(process.env, testHome),
      stdio: "inherit",
    });
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  return typeof result.status === "number" ? result.status : 1;
}

function runControlledPass(files) {
  var controlled = files.filter(isControlledSuite);
  if (controlled.length === 0) return 0;
  console.log("\n# controlled-execution pass (" + controlled.length + " suites)");
  var status = 0;
  for (var i = 0; i < controlled.length; i++) {
    // One suite per spawn: all suites sharing a CLAY_HOME also share a single
    // control store, and committed execution state leaks across files.
    var suiteStatus = spawnPass([controlled[i]], controlledTestEnvironment);
    if (suiteStatus !== 0) status = suiteStatus;
  }
  return status;
}

function run() {
  var requested = process.argv.slice(2);
  var files = requested.length > 0 ? requested : defaultTestFiles();
  var status = spawnPass(files, isolatedTestEnvironment);
  var controlledStatus = runControlledPass(files);
  process.exitCode = status !== 0 ? status : controlledStatus;
}

if (require.main === module) run();

module.exports = {
  sanitizedTestEnvironment: sanitizedTestEnvironment,
  isolatedTestEnvironment: isolatedTestEnvironment,
  controlledTestEnvironment: controlledTestEnvironment,
  isControlledSuite: isControlledSuite,
  defaultTestFiles: defaultTestFiles,
};
