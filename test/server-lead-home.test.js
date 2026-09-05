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
