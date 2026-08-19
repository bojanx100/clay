#!/usr/bin/env node

var fs = require("fs");
var os = require("os");
var path = require("path");
var spawn = require("child_process").spawn;
var { COOP_CONTROL_ENVIRONMENT } = require("../lib/config");

var REPO_ROOT = path.join(__dirname, "..");

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
  var testDir = path.join(REPO_ROOT, "test");
  return fs.readdirSync(testDir).filter(function (name) {
    return name.slice(-8) === ".test.js";
  }).sort().map(function (name) {
    return path.join(testDir, name);
  });
}

// One process per file, each with its own CLAY_HOME. The suite used to run as a
// single `node --test <all files>` spawn sharing one home, so files interleaved
// against shared on-disk state: identical runs at one commit reported 2895, 2898
// and 2901 tests, and changing the interleaving surfaced order-dependent
// failures the gate could not otherwise see. The controlled pass already
// spawned per file for exactly this reason; the default pass now does the same.
// Files still run concurrently -- isolation is the fix, not serialization.
function testConcurrency() {
  var requested = Number(process.env.CLAY_TEST_CONCURRENCY);
  if (Number.isFinite(requested) && requested >= 1) return Math.floor(requested);
  var cores = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, cores);
}

function testArgs(summaryPath) {
  return [
    "--test",
    // The second reporter is the only way to read a file's own totals: the
    // human stream is buffered for attribution, not parsed. "spec" is node's
    // default, restated so adding a reporter does not silently switch the
    // visible output to TAP.
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    "--test-reporter-destination=" + summaryPath,
  ];
}

// Read the machine-readable copy of the file's run rather than the human
// output. Returns null when the file produced no summary at all, which is how a
// crashed, killed or truncated file is detected.
function parseTapSummary(summaryPath) {
  var text;
  try { text = fs.readFileSync(summaryPath, "utf8"); } catch (e) { return null; }
  var tests = /^# tests (\d+)$/m.exec(text);
  if (!tests) return null;
  var pass = /^# pass (\d+)$/m.exec(text);
  var fail = /^# fail (\d+)$/m.exec(text);
  return {
    tests: Number(tests[1]),
    pass: pass ? Number(pass[1]) : 0,
    fail: fail ? Number(fail[1]) : 0,
  };
}

function displayName(file) {
  var relative = path.relative(REPO_ROOT, path.resolve(file));
  return relative.slice(0, 2) === ".." ? file : relative;
}

// Per-file homes are created in bulk now, so an interrupted run would strand up
// to one temp directory per in-flight file instead of the single one the old
// all-files spawn used. Track them so Ctrl-C still cleans up.
var activeTempPaths = {};

function trackTempPath(target) {
  activeTempPaths[target] = true;
}

function releaseTempPath(target) {
  delete activeTempPaths[target];
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

function releaseAllTempPaths() {
  var targets = Object.keys(activeTempPaths);
  for (var i = 0; i < targets.length; i++) releaseTempPath(targets[i]);
}

var activeChildren = {};

function installInterruptCleanup() {
  var signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (var i = 0; i < signals.length; i++) {
    process.on(signals[i], function (signal) {
      var pids = Object.keys(activeChildren);
      for (var j = 0; j < pids.length; j++) {
        try { activeChildren[pids[j]].kill("SIGTERM"); } catch (e) { /* already gone */ }
      }
      releaseAllTempPaths();
      // Re-raise so the caller sees a signal death, not a plain exit code. The
      // listener has to go first or the re-raise would re-enter this handler.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

function runFile(file, environmentFor, summaryDir, index) {
  return new Promise(function (resolve) {
    // The TAP summary lives outside CLAY_HOME on purpose: suites that clear
    // their own home would otherwise delete the file the runner counts from and
    // look indistinguishable from a crash.
    var summaryPath = path.join(summaryDir, index + ".tap");
    var testHome = null;
    var chunks = [];
    var settled = false;
    var child;

    function finish(status, signal, error) {
      if (settled) return;
      settled = true;
      var summary = parseTapSummary(summaryPath);
      // Remove the summary as soon as it is read. Both passes share one summary
      // directory and number files from zero, so a leftover report from the
      // default pass could otherwise be counted as a controlled-pass result and
      // hide a file that produced nothing.
      try { fs.rmSync(summaryPath, { force: true }); } catch (e) { /* best effort */ }
      if (testHome) releaseTempPath(testHome);
      if (child && child.pid) delete activeChildren[child.pid];
      resolve({
        file: file,
        status: status,
        signal: signal || null,
        error: error || null,
        summary: summary,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    }

    // A failure to create the home or spawn the child must surface as an
    // unaccounted file, not as an unhandled rejection that kills the whole run.
    try {
      testHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-test-file-"));
      trackTempPath(testHome);
      child = spawn(process.execPath, testArgs(summaryPath).concat([file]), {
        env: environmentFor(process.env, testHome),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish(1, null, e);
      return;
    }
    if (child.pid) activeChildren[child.pid] = child;

    child.stdout.on("data", function (chunk) { chunks.push(chunk); });
    child.stderr.on("data", function (chunk) { chunks.push(chunk); });
    child.on("error", function (error) { finish(1, null, error); });
    child.on("close", function (code, signal) {
      finish(typeof code === "number" ? code : 1, signal, null);
    });
  });
}

function printFileResult(result, done, total) {
  var counts = result.summary
    ? result.summary.tests + " tests, " + result.summary.pass + " pass, " +
      result.summary.fail + " fail"
    : "NO RESULT REPORTED";
  process.stdout.write("\n# [" + done + "/" + total + "] " + displayName(result.file) +
    " (" + counts + ")\n");
  if (result.output) {
    process.stdout.write(result.output);
    if (result.output.slice(-1) !== "\n") process.stdout.write("\n");
  }
  if (result.error) {
    process.stdout.write("! spawn error: " + result.error.message + "\n");
  }
}

// Bounded worker pool: `concurrency` files in flight, each in its own process
// and its own CLAY_HOME. Output is buffered per file and flushed when that file
// finishes, so concurrent runs stay attributable.
function runFiles(files, environmentFor, summaryDir, concurrency) {
  return new Promise(function (resolve) {
    if (files.length === 0) {
      resolve([]);
      return;
    }
    var results = [];
    var next = 0;
    var active = 0;

    function settle(result) {
      results.push(result);
      active--;
      printFileResult(result, results.length, files.length);
      if (active === 0 && next >= files.length) {
        resolve(results);
        return;
      }
      pump();
    }

    function pump() {
      while (active < concurrency && next < files.length) {
        var index = next;
        next++;
        active++;
        runFile(files[index], environmentFor, summaryDir, index).then(settle);
      }
    }

    pump();
  });
}

// Exact coverage accounting. A run that lost whole files still exits 0 with
// zero failures, so coverage has to be checked separately from pass/fail. Every
// launched file must report a parseable total; "every file reported" is a
// strictly stronger guarantee than the test-count floor this replaces, and it
// names the file that vanished instead of printing a number that drifted.
function accountForResults(files, results) {
  var byFile = {};
  for (var i = 0; i < results.length; i++) byFile[results[i].file] = results[i];

  var totals = { files: files.length, tests: 0, pass: 0, fail: 0 };
  var failed = [];
  var missing = [];

  for (var j = 0; j < files.length; j++) {
    var result = byFile[files[j]];
    if (!result || !result.summary) {
      missing.push({
        file: files[j],
        reason: describeMissing(result),
      });
      continue;
    }
    totals.tests += result.summary.tests;
    totals.pass += result.summary.pass;
    totals.fail += result.summary.fail;
    if (result.summary.fail > 0 || result.status !== 0) failed.push(result);
  }

  return { totals: totals, failed: failed, missing: missing };
}

function describeMissing(result) {
  if (!result) return "never completed";
  if (result.error) return "spawn error: " + result.error.message;
  if (result.signal) return "killed by " + result.signal;
  return "exited " + result.status + " without a test summary";
}

function reportAccounting(label, accounting) {
  var totals = accounting.totals;
  console.log("\n# " + label + " total: " + totals.tests + " tests, " + totals.pass +
    " pass, " + totals.fail + " fail across " + totals.files + " files");

  if (accounting.failed.length > 0) {
    console.error("\n! " + label + ": " + accounting.failed.length + " file(s) failed");
    for (var i = 0; i < accounting.failed.length; i++) {
      var result = accounting.failed[i];
      console.error("!   " + displayName(result.file) + " (" +
        result.summary.fail + " fail, exit " + result.status + ")");
    }
  }

  if (accounting.missing.length > 0) {
    console.error("\n! " + label + ": " + accounting.missing.length +
      " file(s) reported no result, so their coverage is unverified");
    for (var j = 0; j < accounting.missing.length; j++) {
      console.error("!   " + displayName(accounting.missing[j].file) + " -- " +
        accounting.missing[j].reason);
    }
  }

  return accounting.failed.length > 0 || accounting.missing.length > 0 ? 1 : 0;
}

async function run() {
  var requested = process.argv.slice(2);
  var files = requested.length === 0 ? defaultTestFiles() : requested;
  var concurrency = testConcurrency();
  var summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-test-summaries-"));
  var status = 0;

  trackTempPath(summaryDir);
  installInterruptCleanup();

  try {
    console.log("# default pass (" + files.length + " files, concurrency " +
      concurrency + ")");
    var defaultResults = await runFiles(files, isolatedTestEnvironment, summaryDir,
      concurrency);
    status = reportAccounting("default pass", accountForResults(files, defaultResults));

    var controlled = files.filter(isControlledSuite);
    if (controlled.length > 0) {
      console.log("\n# controlled-execution pass (" + controlled.length +
        " suites, concurrency " + concurrency + ")");
      var controlledResults = await runFiles(controlled, controlledTestEnvironment,
        summaryDir, concurrency);
      var controlledStatus = reportAccounting("controlled pass",
        accountForResults(controlled, controlledResults));
      if (controlledStatus !== 0) status = controlledStatus;
    }
  } finally {
    releaseTempPath(summaryDir);
  }

  process.exitCode = status;
}

if (require.main === module) {
  run().catch(function (error) {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  sanitizedTestEnvironment: sanitizedTestEnvironment,
  isolatedTestEnvironment: isolatedTestEnvironment,
  controlledTestEnvironment: controlledTestEnvironment,
  isControlledSuite: isControlledSuite,
  defaultTestFiles: defaultTestFiles,
  testConcurrency: testConcurrency,
  parseTapSummary: parseTapSummary,
  accountForResults: accountForResults,
};
