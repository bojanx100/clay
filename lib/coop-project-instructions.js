var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var local = require("./project-local-instructions");
var refs = require("./coop-project-instruction-refs");

// Large living project instructions must fit without silently losing rules.
// This is a byte guard, not a claim about a provider's remaining token budget.
var MAX_BYTES = 512 * 1024;
var MAX_FILES = 64;

function digest(value) { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }

function loadInstructions(cwd) {
  var files = [];
  var supporting = [];
  var problems = [];
  var total = 0;
  var seen = new Set();
  var root;
  try {
    root = fs.realpathSync(cwd);
    if (!fs.statSync(root).isDirectory()) return { ok: false, reason: "project_directory_unavailable" };
    var loaded = local.attachProjectLocalInstructions({ cwd: root }).loadForStaffing();
    if (!loaded.ok) return loaded;
    var pending = [];
    ["AGENTS.md", "CLAUDE.md"].forEach(function (name) {
      // Discover case variants instead of assuming a case-insensitive host.
      fs.readdirSync(root).filter(function (entry) {
        return entry.toLowerCase() === name.toLowerCase();
      }).sort().forEach(function (entry) { pending.push({ path: entry, from: null }); });
    });
    loaded.files.forEach(function (file) { pending.push({ path: file.path, from: null }); });
    while (pending.length) {
      var next = pending.shift();
      var real = fs.realpathSync(path.join(root, next.path));
      if (!refs.inside(root, real)) { problems.push({ path: next.path, reason: "instruction_reference_outside_project" }); continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      var bytes = fs.statSync(real).size;
      if (total + bytes > MAX_BYTES || files.length >= MAX_FILES) {
        problems.push({ path: next.path, reason: "project_instructions_too_large" }); break;
      }
      var body = fs.readFileSync(real, "utf8");
      total += Buffer.byteLength(body, "utf8");
      if (total > MAX_BYTES) { problems.push({ path: next.path, reason: "project_instructions_too_large" }); break; }
      if (!body.trim()) { problems.push({ path: next.path, reason: "project_instruction_reference_empty" }); continue; }
      var relative = path.relative(root, real).split(path.sep).join("/");
      files.push({ path: relative, body: body, digest: digest(body), referencedBy: next.from });
      refs.references(body, relative).forEach(function (reference) {
        var resolved = refs.resolveReference(root, relative, reference.path);
        if (resolved.reason === "project_instruction_reference_missing" && path.basename(reference.path) === reference.path) {
          var known = files.concat(pending).filter(function (file) { return path.basename(file.path) === reference.path; });
          var unique = Array.from(new Set(known.map(function (file) { return file.path; })));
          if (unique.length === 1) resolved = { path: unique[0] };
        }
        if (reference.required) {
          if (resolved.reason) problems.push({ path: reference.path, referencedBy: relative, reason: resolved.reason });
          else pending.push({ path: resolved.path, from: relative });
        } else supporting.push({ path: resolved.path || reference.path, referencedBy: relative,
          available: !resolved.reason, reason: resolved.reason || null });
      });
    }
  } catch (error) { problems.push({ reason: "project_instructions_unreadable" }); }
  var manifest = { version: 1, complete: problems.length === 0, bytes: total,
    files: files.map(function (file) { return { path: file.path, digest: file.digest, referencedBy: file.referencedBy }; }),
    supporting: supporting.filter(function (item, index, all) {
      return !files.some(function (file) { return file.path === item.path; }) &&
        all.findIndex(function (entry) { return entry.path === item.path; }) === index;
    }), problems: problems };
  manifest.digest = digest(JSON.stringify(manifest));
  if (problems.length) return { ok: false, reason: problems[0].reason,
    missing: problems.filter(function (item) { return /missing|empty/.test(item.reason); }).map(function (item) { return item.path; }),
    manifest: manifest };
  return { ok: true, files: files, manifest: manifest,
    ownerAcceptanceRequired: local.requiresOwnerAcceptance(files) };
}

module.exports = { loadInstructions: loadInstructions, MAX_BYTES: MAX_BYTES, MAX_FILES: MAX_FILES };
