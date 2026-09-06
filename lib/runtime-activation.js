// Activation evidence belongs to the process serving Clay, not the checkout
// that asked it to restart. Capture source identity before loading the server.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var execFileSync = require("child_process").execFileSync;

function sourceIdentity(directory) {
  var root = fs.realpathSync(directory);
  function git(args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000,
      maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  }
  var head = git(["rev-parse", "HEAD"]).trim();
  var files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    "lib", "bin", "package.json", "package-lock.json"]).split("\0").filter(Boolean).sort();
  var hash = crypto.createHash("sha256");
  files.forEach(function (name) {
    hash.update(name + "\0");
    try { hash.update(fs.readFileSync(path.join(root, name))); }
    catch (error) { if (error.code === "ENOENT") hash.update("<deleted>"); else throw error; }
    hash.update("\0");
  });
  return { checkout: root, revision: head, sourceDigest: hash.digest("hex") };
}

function matches(actual, expected) {
  return !!(actual && expected && expected.checkout && /^[a-f0-9]{40}$/.test(expected.revision || "") &&
    /^[a-f0-9]{64}$/.test(expected.sourceDigest || "") && actual.checkout === expected.checkout &&
    actual.revision === expected.revision && actual.sourceDigest === expected.sourceDigest);
}

function verify(observation, expected) {
  if (!observation || !matches(observation.boot, expected) || !matches(observation.disk, expected)) return { ok: false,
    code: "ACTIVATION_NOT_VERIFIED", error: "The serving process has not loaded the expected checkout and source.",
    runtime: observation || null };
  return { ok: true, activationVerified: true, runtime: observation };
}

function capture(directory) {
  var boot = null;
  try { boot = sourceIdentity(directory); } catch (error) {}
  var startedAt = Date.now();
  function inspect() {
    var disk = null;
    try { disk = sourceIdentity(directory); } catch (error) {}
    return { pid: process.pid, startedAt: startedAt, boot: boot, disk: disk,
      sourceChangedSinceBoot: !!(boot && disk && !matches(boot, disk)) };
  }
  function preflight(expected) {
    var observed = inspect();
    if (!matches(observed.disk, expected)) return { ok: false, code: "ACTIVATION_TARGET_MISMATCH",
      error: "Restart refused: this daemon's checkout does not contain the expected source. Select or update the correct runtime first.",
      runtime: observed };
    if (verify(observed, expected).ok) return { ok: true, alreadyActive: true,
      activationVerified: true, runtime: observed };
    return { ok: true, activationPending: true, runtime: observed };
  }
  return { inspect: inspect, preflight: preflight };
}

module.exports = { sourceIdentity: sourceIdentity, capture: capture, verify: verify };
