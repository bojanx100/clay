// Signed repair manifests are deliberately data, never a shell program. The
// worker receives argv arrays and constrained paths, and this module proves
// those paths cannot escape the approved project tree through traversal or a
// symlink.

var fsModule = require("fs");
var path = require("path");
var schema = require("./coop-emergency-repair-schema");

var MAX_PATCH_BYTES = 65536;
var MAX_COMMANDS = 8;
var MAX_PATHS = 24;

function manifestError(code, message) {
  return schema.error(code, message);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", label + " must be a plain object.");
  }
  var allowed = {};
  for (var i = 0; i < fields.length; i++) allowed[fields[i]] = true;
  var keys = Object.keys(value);
  for (var j = 0; j < keys.length; j++) {
    if (!allowed[keys[j]]) {
      throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", label + " has an unknown field.");
    }
  }
  for (var k = 0; k < fields.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(value, fields[k])) {
      throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", label + " is missing " + fields[k] + ".");
    }
  }
  return value;
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value || value.length > 512 ||
      value.indexOf("\0") !== -1 || path.isAbsolute(value) || value.indexOf("\\") !== -1) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", label + " is not a safe relative path.");
  }
  var normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.indexOf("../") === 0 ||
      normalized.indexOf("/") === 0 || normalized !== value) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", label + " escapes its root.");
  }
  return normalized;
}

function safeArg(value, label) {
  if (typeof value !== "string" || !value || value.length > 512 ||
      /[\0\r\n]/.test(value)) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", label + " is invalid.");
  }
  return value;
}

function normalizeCommand(value, index) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 16) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", "manifest.commands[" + index + "] is invalid.");
  }
  var command = [];
  for (var i = 0; i < value.length; i++) command.push(safeArg(value[i], "command argument"));
  // No shell, package script, arbitrary node program, or test discovery. V1
  // executes only an explicit Node test file under test/.
  if (command[0] !== "node" || command[1] !== "--test") {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", "Only explicit node --test commands are allowed.");
  }
  for (var j = 2; j < command.length; j++) {
    var target = safeRelative(command[j], "test command target");
    if (target.indexOf("test/") !== 0 || path.posix.extname(target) !== ".js") {
      throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", "Only test/*.js command targets are allowed.");
    }
    command[j] = target;
  }
  return command;
}

function normalizeManifest(value) {
  var source = exactObject(value, ["version", "recipe", "patchPaths", "commands", "maxPatchBytes"],
    "manifest");
  if (source.version !== 1 || source.recipe !== schema.RECIPE ||
      !Array.isArray(source.patchPaths) || !Array.isArray(source.commands) ||
      source.patchPaths.length < 1 || source.patchPaths.length > MAX_PATHS ||
      source.commands.length < 1 || source.commands.length > MAX_COMMANDS ||
      !Number.isSafeInteger(source.maxPatchBytes) || source.maxPatchBytes < 1 ||
      source.maxPatchBytes > MAX_PATCH_BYTES) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", "Manifest is outside the v1 repair allowlist.");
  }
  var paths = [];
  var seen = {};
  for (var i = 0; i < source.patchPaths.length; i++) {
    var patchPath = safeRelative(source.patchPaths[i], "manifest.patchPaths[" + i + "]");
    if (seen[patchPath]) throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", "Manifest paths must be unique.");
    seen[patchPath] = true;
    // The designated break-glass repair may only touch its own code and its
    // direct proof. Policy, grants, runtime config, or unrelated project work
    // cannot be smuggled into its patch list.
    if (patchPath.indexOf("lib/coop-emergency-repair-") !== 0 &&
        patchPath !== "lib/coop-action-decision.js" &&
        patchPath.indexOf("test/coop-emergency-repair-") !== 0 &&
        patchPath !== "test/coop-action-decision.test.js") {
      throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", "Manifest patch path is not allowlisted.");
    }
    paths.push(patchPath);
  }
  var commands = [];
  for (var j = 0; j < source.commands.length; j++) commands.push(normalizeCommand(source.commands[j], j));
  return {
    version: 1,
    recipe: schema.RECIPE,
    patchPaths: paths.sort(),
    commands: commands,
    maxPatchBytes: source.maxPatchBytes,
  };
}

function signaturePayload(manifest) {
  var normalized = normalizeManifest(manifest);
  return { manifest: normalized, manifestDigest: schema.stableDigest(normalized) };
}

function signManifest(manifest, authenticator) {
  if (!authenticator || typeof authenticator.sign !== "function") {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_AUTH", "Manifest signer is unavailable.");
  }
  var payload = signaturePayload(manifest);
  return { manifest: payload.manifest, manifestDigest: payload.manifestDigest,
    signature: authenticator.sign(payload) };
}

function verifyManifest(envelope, authenticator) {
  var source = exactObject(envelope, ["manifest", "manifestDigest", "signature"], "manifest envelope");
  if (!authenticator || typeof authenticator.verify !== "function") {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_AUTH", "Manifest verifier is unavailable.");
  }
  var payload = signaturePayload(source.manifest);
  if (payload.manifestDigest !== source.manifestDigest ||
      !authenticator.verify(payload, source.signature)) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_AUTH", "Manifest signature or digest is invalid.");
  }
  return { manifest: payload.manifest, manifestDigest: payload.manifestDigest,
    signature: source.signature };
}

function isInside(root, candidate) {
  return candidate === root || candidate.indexOf(root + path.sep) === 0;
}

function nearestExistingParent(fs, target) {
  var current = target;
  while (!fs.existsSync(current)) {
    var parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function verifyPaths(envelope, projectRoot, authenticator, options) {
  var fs = options && options.fs || fsModule;
  var verified = verifyManifest(envelope, authenticator);
  if (typeof projectRoot !== "string" || !projectRoot) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_INVALID", "Project root is required.");
  }
  var root = fs.realpathSync(projectRoot);
  var checked = [];
  for (var i = 0; i < verified.manifest.patchPaths.length; i++) {
    var relative = verified.manifest.patchPaths[i];
    var target = path.resolve(root, relative);
    if (!isInside(root, target)) {
      throw manifestError("EMERGENCY_REPAIR_MANIFEST_PATH_ESCAPE", "Manifest path escapes the project root.");
    }
    var existing = nearestExistingParent(fs, target);
    if (!existing || !isInside(root, fs.realpathSync(existing))) {
      throw manifestError("EMERGENCY_REPAIR_MANIFEST_PATH_ESCAPE", "Manifest path resolves outside the project root.");
    }
    if (fs.existsSync(target)) {
      var stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !isInside(root, fs.realpathSync(target))) {
        throw manifestError("EMERGENCY_REPAIR_MANIFEST_PATH_ESCAPE", "Manifest path is a symlink or resolves outside the project root.");
      }
    }
    checked.push(target);
  }
  return Object.assign({}, verified, { projectRoot: root, resolvedPatchPaths: checked });
}

function assertPatchSize(bytes, envelope, authenticator) {
  var verified = verifyManifest(envelope, authenticator);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > verified.manifest.maxPatchBytes) {
    throw manifestError("EMERGENCY_REPAIR_MANIFEST_PATCH_LIMIT", "Repair patch exceeds its signed byte limit.");
  }
  return true;
}

module.exports = {
  MAX_PATCH_BYTES: MAX_PATCH_BYTES,
  assertPatchSize: assertPatchSize,
  normalizeManifest: normalizeManifest,
  signManifest: signManifest,
  verifyManifest: verifyManifest,
  verifyPaths: verifyPaths,
};
