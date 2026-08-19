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

// The runner used to pass --test-force-exit, which tears the process down as
// soon as the top-level runner thinks it is finished and takes still-running
// test files with it. Their remaining cases were never reported, yet the run
// still exited 0 with zero failures, so the gate silently under-reported
// coverage: identical runs at one commit produced 2885, 2893 and 2895 tests.
//
// Removing the flag does not make the total fully deterministic: the suite
// still varies by a handful of tests across identical runs (2895-2901 observed)
// because test files share one CLAY_HOME for the pass and interleave against it.
// That is a separate defect. The floor is therefore set below the observed
// range rather than at it, so it catches a file-sized regression -- which is
// what truncation produced -- without flaking on that residual noise. Tighten
// it once per-file isolation lands.
var EXPECTED_MIN_TESTS = 2890;

function testArgs(summaryPath) {
  return [
    "--test",
    // The second reporter is the only way to read the run's own totals: the
    // human stream is inherited straight by the terminal and never buffered
    // here. "spec" is node's default, restated so adding a reporter does not
    // silently switch the visible output to TAP.
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    "--test-reporter-destination=" + summaryPath,
  ];
}

// Read the machine-readable copy of the run rather than the human output, which
// is streamed straight through to the terminal.
function reportedTestCount(summaryPath) {
  var text;
  try { text = fs.readFileSync(summaryPath, "utf8"); } catch (e) { return null; }
  var match = /^# tests (\d+)$/m.exec(text);
  return match ? Number(match[1]) : null;
}

function spawnPass(files, environmentFor) {
  var testHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-test-run-"));
  var summaryPath = path.join(testHome, "summary.tap");
  var result = null;
  var reported = null;
  try {
    result = spawnSync(process.execPath, testArgs(summaryPath).concat(files), {
      env: environmentFor(process.env, testHome),
      stdio: "inherit",
    });
    reported = reportedTestCount(summaryPath);
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  return {
    status: typeof result.status === "number" ? result.status : 1,
    reported: reported,
  };
}

function runControlledPass(files) {
  var controlled = files.filter(isControlledSuite);
  if (controlled.length === 0) return 0;
  console.log("\n# controlled-execution pass (" + controlled.length + " suites)");
  var status = 0;
  for (var i = 0; i < controlled.length; i++) {
    // One suite per spawn: all suites sharing a CLAY_HOME also share a single
    // control store, and committed execution state leaks across files.
    var suiteStatus = spawnPass([controlled[i]], controlledTestEnvironment).status;
    if (suiteStatus !== 0) status = suiteStatus;
  }
  return status;
}

// A run that lost whole files still exits 0 with zero failures, so coverage has
// to be checked separately from pass/fail. Only the default full-suite run is
// held to the floor; an explicit file list is a deliberately partial run.
function coverageFailure(reported, wholeSuite) {
  if (!wholeSuite) return 0;
  if (reported === null) {
    console.warn("\n! could not read the run's test total; coverage was not verified");
    return 0;
  }
  if (reported >= EXPECTED_MIN_TESTS) return 0;
  console.error("\n! coverage regression: " + reported + " tests ran, expected at least " +
    EXPECTED_MIN_TESTS);
  // Deliberately not path.relative(process.cwd(), ...): this must still print
  // when the runner is invoked from a directory it cannot resolve.
  console.error("! if tests were removed on purpose, lower EXPECTED_MIN_TESTS in " +
    "scripts/" + path.basename(__filename));
  return 1;
}

function run() {
  var requested = process.argv.slice(2);
  var wholeSuite = requested.length === 0;
  var files = wholeSuite ? defaultTestFiles() : requested;
  var pass = spawnPass(files, isolatedTestEnvironment);
  var controlledStatus = runControlledPass(files);
  var coverageStatus = coverageFailure(pass.reported, wholeSuite);
  process.exitCode = pass.status !== 0 ? pass.status : (controlledStatus || coverageStatus);
}

if (require.main === module) run();

module.exports = {
  sanitizedTestEnvironment: sanitizedTestEnvironment,
  isolatedTestEnvironment: isolatedTestEnvironment,
  controlledTestEnvironment: controlledTestEnvironment,
  isControlledSuite: isControlledSuite,
  defaultTestFiles: defaultTestFiles,
};
