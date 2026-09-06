var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var loader = require("../lib/coop-project-instructions");

function fixture(t) {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-rules-"));
  t.after(function () { fs.rmSync(cwd, { recursive: true, force: true }); });
  function write(name, body) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), body);
  }
  return { cwd: cwd, write: write, load: function () { return loader.loadInstructions(cwd); } };
}

test("discovers recursive governing rules, cycles and supporting references from real files", function (t) {
  var f = fixture(t);
  f.write("agents.md", "Always read [project rules](rules/policy.md).\n\nSee [design](docs/design.md).\n\n```sh\ncat missing-example.md\n```\n");
  f.write("CLAUDE.md", "@agents.md");
  f.write("rules/policy.md", "Before accepting work, read `triage.local.md`.\n\nTemplate: `missing-template.md`.");
  f.write("rules/triage.local.md", "Follow `../agents.md`. Ask before changing the billing contract.");
  f.write("docs/design.md", "A supporting design example.");
  var result = f.load();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.files.map(function (file) { return file.path; }),
    ["agents.md", "CLAUDE.md", "rules/policy.md", "rules/triage.local.md"]);
  assert.match(result.files[3].body, /billing contract/);
  assert.equal(result.manifest.supporting.find(function (file) { return file.path === "docs/design.md"; }).available, true);
  assert.equal(result.manifest.complete, true);
});

test("missing, changed and empty transitive instructions cannot yield a partial complete context", function (t) {
  var f = fixture(t);
  f.write("AGENTS.md", "Read `rules.md` before acting.");
  assert.equal(f.load().reason, "project_instruction_reference_missing");
  assert.equal(f.load().files, undefined);
  f.write("rules.md", "Require approval before shipping.");
  var first = f.load();
  f.write("rules.md", "Require approval before any external write.");
  assert.notEqual(f.load().manifest.digest, first.manifest.digest);
  f.write("rules.md", "");
  assert.equal(f.load().reason, "project_instruction_reference_empty");
});

test("ambiguous relative references and symlink escapes fail without reading an outside rule body", function (t) {
  var f = fixture(t);
  f.write("AGENTS.md", "Read `rules/policy.md`.");
  f.write("rules/policy.md", "Read `triage.md`.");
  f.write("rules/triage.md", "Project local");
  f.write("triage.md", "Root local");
  assert.equal(f.load().reason, "ambiguous_instruction_reference");
  fs.unlinkSync(path.join(f.cwd, "rules/triage.md"));
  fs.symlinkSync(os.tmpdir(), path.join(f.cwd, "outside"));
  f.write("AGENTS.md", "Read `outside/" + path.basename(f.cwd) + "/triage.md`.\n\nRead `../../not-project.md`.");
  assert.equal(f.load().reason, "instruction_reference_outside_project");
});

test("a large governing file is supplied whole or explicitly blocked by the byte bound", function (t) {
  var f = fixture(t);
  f.write("AGENTS.md", "Before work read `context.md`.");
  f.write("context.md", "Project rules. ".repeat(26000));
  var large = f.load();
  assert.equal(large.ok, true);
  assert.equal(large.files[1].body, fs.readFileSync(path.join(f.cwd, "context.md"), "utf8"));
  f.write("context.md", "x".repeat(loader.MAX_BYTES));
  assert.equal(f.load().reason, "project_instructions_too_large");
  assert.equal(f.load().files, undefined);
});

test("descriptive tables and templates do not become mandatory missing rules", function (t) {
  var f = fixture(t);
  f.write("AGENTS.md", "Read `map.md` before adding code.");
  f.write("map.md", "| Module | Description |\n| --- | --- |\n| loader | Never reads `TRIAGE.local.md` |\n\nPlan template: `missing.md`.\n");
  assert.equal(f.load().ok, true);
  assert.equal(f.load().files.length, 2);
  assert.equal(f.load().manifest.supporting.length, 2);
});
