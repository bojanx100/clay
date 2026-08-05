var test = require("node:test");
var assert = require("node:assert");

var serverLead = require("../lib/server-lead");
var projectIdentity = require("../lib/project-identity");

function makeHarness(leadMode, existingLead) {
  var calls = [];
  var projects = existingLead ? [{ slug: "lead", isLead: true }] : [];
  var clayCwd = process.cwd();
  var usersModule = {
    getLegacyLeadMode: function (userId) {
      assert.strictEqual(userId, "owner-1");
      return leadMode;
    },
    getAllUsers: function () {
      return [{ id: "owner-1" }];
    },
  };
  var ctx = {
    usersModule: usersModule,
    leadMode: {
      getLeadModeState: function (options) {
        assert.strictEqual(options.ownerId, "owner-1");
        return { enabled: leadMode };
      },
    },
    configProjects: [{ slug: "clay", path: clayCwd, ownerId: "owner-1" }],
    clayCwd: clayCwd,
    getProjects: function () {
      return projects;
    },
    addProject: function (cwd, slug, name, icon, ownerId, worktreeMeta, extra) {
      var call = {
        cwd: cwd,
        slug: slug,
        name: name,
        icon: icon,
        ownerId: ownerId,
        worktreeMeta: worktreeMeta,
        extra: extra,
      };
      calls.push(call);
      projects.push({ slug: slug, isLead: extra.isLead });
      return true;
    },
  };
  return { ctx: ctx, calls: calls, projects: projects, clayCwd: clayCwd };
}

test("registerLeadProject registers the permanent Coop pseudo-project when Lead mode is enabled", function () {
  var h = makeHarness(true, false);
  var result = serverLead.registerLeadProject(h.ctx);

  assert.deepStrictEqual(result, { ok: true, added: true, reason: "added", ownerId: "owner-1" });
  assert.strictEqual(h.calls.length, 1);
  // The Lead gets its OWN workspace cwd (session storage is keyed by cwd);
  // registering with the clay checkout would mirror every clay session.
  assert.strictEqual(h.calls[0].cwd, serverLead.getLeadWorkspaceDir());
  assert.notStrictEqual(h.calls[0].cwd, h.clayCwd);
  assert.strictEqual(h.calls[0].slug, "lead");
  assert.strictEqual(h.calls[0].name, "Coop");
  assert.strictEqual(h.calls[0].ownerId, "owner-1");
  assert.deepStrictEqual(h.calls[0].extra, { isLead: true });
  assert.strictEqual(h.projects[0].isLead, true);
  assert.strictEqual(
    projectIdentity.projectIdForRuntime(h.calls[0].extra, h.calls[0].cwd, h.calls[0].slug),
    projectIdentity.LEAD_PROJECT_ID
  );
});

test("registerLeadProject registers permanent Coop even when Lead mode is disabled", function () {
  var h = makeHarness(false, false);
  var result = serverLead.registerLeadProject(h.ctx);

  assert.deepStrictEqual(result, { ok: true, added: true, reason: "added", ownerId: "owner-1" });
  assert.strictEqual(h.calls.length, 1);
  assert.deepStrictEqual(h.projects, [{ slug: "lead", isLead: true }]);
});

test("registerLeadProject keeps Coop persistent before an owner identity is available", function () {
  var calls = [];
  var result = serverLead.registerLeadProject({
    usersModule: { getAllUsers: function () { return [{ id: "a" }, { id: "b" }]; } },
    configProjects: [],
    clayCwd: process.cwd(),
    getProjects: function () { return []; },
    addProject: function (cwd, slug, name, icon, ownerId, worktreeMeta, extra) {
      calls.push({ cwd: cwd, slug: slug, name: name, ownerId: ownerId, extra: extra });
      return true;
    },
  });

  assert.deepStrictEqual(result, { ok: true, added: true, reason: "added", ownerId: null });
  assert.deepStrictEqual(calls[0], {
    cwd: serverLead.getLeadWorkspaceDir(), slug: "lead", name: "Coop", ownerId: null, extra: { isLead: true },
  });
});

test("registerLeadProject is idempotent when lead pseudo-project already exists", function () {
  var h = makeHarness(true, true);
  var result = serverLead.registerLeadProject(h.ctx);

  assert.deepStrictEqual(result, { ok: true, added: false, reason: "exists" });
  assert.strictEqual(h.calls.length, 0);
  assert.deepStrictEqual(h.projects, [{ slug: "lead", isLead: true }]);
});

test("lead workspace is created with identity file and skill symlink", function () {
  var fs = require("fs");
  var path = require("path");
  var dir = serverLead.ensureLeadWorkspace();
  assert.strictEqual(dir, serverLead.getLeadWorkspaceDir());
  assert.ok(fs.existsSync(path.join(dir, "CLAUDE.md")));
  var link = path.join(dir, ".claude");
  assert.ok(fs.existsSync(link));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});
