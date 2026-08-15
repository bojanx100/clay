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

function defaultTestFiles() {
  var testDir = path.join(__dirname, "..", "test");
  return fs.readdirSync(testDir).filter(function (name) {
    return name.slice(-8) === ".test.js";
  }).sort().map(function (name) {
    return path.join(testDir, name);
  });
}

function run() {
  var requested = process.argv.slice(2);
  var files = requested.length > 0 ? requested : defaultTestFiles();
  var testHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-test-run-"));
  var result = null;
  try {
    result = spawnSync(process.execPath, ["--test", "--test-force-exit"].concat(files), {
      env: isolatedTestEnvironment(process.env, testHome),
      stdio: "inherit",
    });
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  process.exitCode = typeof result.status === "number" ? result.status : 1;
}

if (require.main === module) run();

module.exports = {
  sanitizedTestEnvironment: sanitizedTestEnvironment,
  isolatedTestEnvironment: isolatedTestEnvironment,
  defaultTestFiles: defaultTestFiles,
};
