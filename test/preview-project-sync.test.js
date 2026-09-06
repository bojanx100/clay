var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var sync = require("../scripts/sync-preview-projects").syncPreviewProjects;

function fixture(t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), "clay-preview-sync-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var source = path.join(root, "original");
  var target = path.join(root, "preview");
  fs.mkdirSync(source); fs.mkdirSync(target);
  var projects = ["clay", "webapp", "urban-stay"].map(function (slug, index) {
    var cwd = path.join(root, slug); fs.mkdirSync(cwd);
    return { path: cwd, slug: slug, projectId: "project-" + index, ownerId: "owner-original",
      visibility: "private", githubAccount: "owner", title: slug + " title" };
  });
  function put(dir, name, data) { fs.writeFileSync(path.join(dir, name), JSON.stringify(data)); }
  put(source, "daemon-dev.json", { port: 7292, pid: process.pid, projects: projects,
    defaultClaudeModel: "claude-opus-5", defaultEffort: "xhigh", chatLayout: "bubble",
    coop: { leadMode: { enabled: true } }, pinHash: "source-auth" });
  put(target, "daemon-dev.json", { port: 7392, host: "127.0.0.1", tls: false, projects: [],
    coop: { leadMode: { enabled: false }, controlKernel: { store: true } }, pinHash: "preview-auth",
    futureSetting: { preserve: true } });
  put(source, "users.json", { users: [{ id: "owner-original", role: "admin", pinHash: "source-user-auth",
    chatLayout: "bubble", projectLastVendors: { webapp: "codex" } }] });
  put(target, "users.json", { users: [{ id: "owner-preview", role: "admin", pinHash: "preview-user-auth" }] });
  return { source: source, target: target, projects: projects, put: put };
}

test("preview sync discovers every registered project, maps private ownership and preserves instance identity", function (t) {
  var f = fixture(t);
  var sourceBefore = fs.readFileSync(path.join(f.source, "daemon-dev.json"), "utf8");
  var targetBefore = fs.readFileSync(path.join(f.target, "daemon-dev.json"), "utf8");
  var preview = sync(f);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.projects, ["clay", "webapp", "urban-stay"]);
  assert.equal(fs.readFileSync(path.join(f.target, "daemon-dev.json"), "utf8"), targetBefore);
  var result = sync(Object.assign({}, f, { apply: true }));
  var actual = JSON.parse(fs.readFileSync(path.join(f.target, "daemon-dev.json")));
  assert.deepEqual(actual.projects, f.projects.map(function (project) {
    return Object.assign({}, project, { ownerId: "owner-preview" });
  }));
  assert.equal(actual.defaultClaudeModel, "claude-opus-5");
  assert.equal(actual.defaultEffort, "xhigh");
  assert.equal(actual.scheduledExecutionPaused, true);
  assert.equal(actual.manageClaudeSettings, false);
  assert.equal(actual.port, 7392);
  assert.equal(actual.host, "127.0.0.1");
  assert.equal(actual.tls, false);
  assert.equal(actual.pinHash, "preview-auth");
  assert.equal(actual.coop.leadMode.enabled, false);
  assert.deepEqual(actual.futureSetting, { preserve: true });
  var user = JSON.parse(fs.readFileSync(path.join(f.target, "users.json"))).users[0];
  assert.equal(user.id, "owner-preview");
  assert.equal(user.pinHash, "preview-user-auth");
  assert.equal(user.chatLayout, "bubble");
  assert.equal(user.projectLastVendors.webapp, "codex");
  assert.equal(fs.readFileSync(path.join(f.source, "daemon-dev.json"), "utf8"), sourceBefore);
  assert.equal(fs.readFileSync(path.join(result.snapshot, "daemon-dev.json"), "utf8"), targetBefore);
  assert.equal(fs.existsSync(path.join(f.target, "sessions")), false);
});

test("preview sync refuses a live destination, same directory or unmapped private owner before writing", function (t) {
  var f = fixture(t);
  var file = path.join(f.target, "daemon-dev.json");
  var config = JSON.parse(fs.readFileSync(file));
  f.put(f.target, "daemon-dev.json", Object.assign({}, config, { pid: process.pid }));
  var before = fs.readFileSync(file, "utf8");
  assert.throws(function () { sync(Object.assign({}, f, { apply: true })); }, /Stop only the preview/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.throws(function () { sync({ source: f.source, target: f.source }); }, /separate state directories/);
  var sourceConfig = JSON.parse(fs.readFileSync(path.join(f.source, "daemon-dev.json")));
  sourceConfig.projects[1].ownerId = "someone-else";
  f.put(f.source, "daemon-dev.json", sourceConfig);
  assert.throws(function () { sync(f); }, /Unmapped project owner/);
});
