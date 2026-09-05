var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var os = require("node:os");
var spawnSync = require("node:child_process").spawnSync;

test("Lead workspace discovery respects the configured state directory without touching a workspace", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-home-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var script = "process.stdout.write(require('./lib/server-lead').getLeadWorkspaceDir());";
  var child = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), encoding: "utf8",
    env: Object.assign({}, process.env, { CLAY_HOME: dir }),
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, path.join(dir, "lead", "workspace"));
  assert.equal(fs.existsSync(path.join(dir, "lead")), false, "discovery does not create or update identity files");
});

test("existing Lead identities migrate stock role conflicts while preserving owner instructions", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-lead-identity-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var workspace = path.join(dir, "lead/workspace");
  fs.mkdirSync(workspace, { recursive: true });
  var identity = path.join(workspace, "CLAUDE.md");
  var legacy = [
    "You are Coop — one person, two power levels. \"Lead\" is your role",
    "label while lead mode is enabled, not a separate identity: with lead",
    "mode on you own the backlog, routing, gates, and reporting (operating",
    "procedure: the `lead-tick` skill); with it off you are a plain",
    "coordinator (find, triage, switch). Binding rule: you connect, never",
    "gatekeep — handing the boss to a session directly always beats",
    "summarizing in the middle.", "", "Owner rule: explain business tradeoffs.", "",
  ].join("\n");
  fs.writeFileSync(identity, legacy);
  var script = "require('./lib/server-lead').ensureLeadWorkspace();";
  function ensure() {
    var child = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."), encoding: "utf8",
      env: Object.assign({}, process.env, { CLAY_HOME: dir }),
    });
    assert.equal(child.status, 0, child.stderr);
    return fs.readFileSync(identity, "utf8");
  }
  var updated = ensure();
  assert.equal(updated.includes("handing the boss to a session directly always beats"), false);
  assert.equal(updated.includes("Owner rule: explain business tradeoffs."), true);
  assert.match(updated, /clay_control_context/);
  assert.match(updated, /Project execution cutover/);
  assert.equal(ensure(), updated, "workspace registration is byte-stable on replay");
});
