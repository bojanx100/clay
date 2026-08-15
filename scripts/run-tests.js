#!/usr/bin/env node

var fs = require("fs");
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
  var result = spawnSync(process.execPath, ["--test", "--test-force-exit"].concat(files), {
    env: sanitizedTestEnvironment(process.env),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = typeof result.status === "number" ? result.status : 1;
}

if (require.main === module) run();

module.exports = {
  sanitizedTestEnvironment: sanitizedTestEnvironment,
  defaultTestFiles: defaultTestFiles,
};
