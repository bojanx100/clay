var path = require("path");
var fs = require("fs");
var os = require("os");

var LEAD_SLUG = "lead";
var LEAD_NAME = "Lead";

function normalizePath(p) {
  if (!p) return "";
  return path.resolve(p);
}

function getDefaultClayCwd() {
  return path.resolve(__dirname, "..");
}

// The Lead pseudo-project gets its OWN cwd (like Mates get their mate dir):
// sessions and loop schedules are keyed by cwd, so sharing the clay repo's
// cwd would make the Lead space mirror every clay session. The workspace
// carries a CLAUDE.md identity file and a .claude symlink back to the clay
// checkout so the lead-tick skill and loop tasks resolve.
function getLeadWorkspaceDir() {
  return path.join(os.homedir(), ".clay", "lead", "workspace");
}

// Idempotent: creates the workspace, identity file and skill symlink.
// Never throws — registration must not take the daemon down.
function ensureLeadWorkspace(clayCwd) {
  var dir = getLeadWorkspaceDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    var claudeLink = path.join(dir, ".claude");
    if (!fs.existsSync(claudeLink)) {
      fs.symlinkSync(path.join(clayCwd || getDefaultClayCwd(), ".claude"), claudeLink, "dir");
    }
    var identity = path.join(dir, "CLAUDE.md");
    if (!fs.existsSync(identity)) {
      fs.writeFileSync(identity, [
        "# Lead (CTO orchestrator)",
        "",
        "You are the Lead. Your operating procedure is the `lead-tick` skill.",
        "The clay checkout you operate on lives at: " + (clayCwd || getDefaultClayCwd()),
        "Run all `node` commands from that directory (`cd` there first);",
        "this workspace only hosts the Lead's conversation space.",
        "",
      ].join("\n"));
    }
  } catch (e) {
    // Best-effort: a broken workspace surfaces on first use, not at boot.
  }
  return dir;
}

function findClayProject(configProjects, clayCwd) {
  var projects = configProjects || [];
  var target = normalizePath(clayCwd || getDefaultClayCwd());
  for (var i = 0; i < projects.length; i++) {
    if (normalizePath(projects[i].path) === target) return projects[i];
  }
  return null;
}

function resolveLeadOwnerId(configProjects, usersModule, clayCwd) {
  var clayProject = findClayProject(configProjects, clayCwd);
  if (clayProject && clayProject.ownerId) return clayProject.ownerId;
  if (usersModule && typeof usersModule.getAllUsers === "function") {
    var allUsers = usersModule.getAllUsers();
    if (allUsers.length === 1) return allUsers[0].id;
  }
  return null;
}

function hasLeadProject(ctx) {
  if (ctx.projects && typeof ctx.projects.has === "function" && ctx.projects.has(LEAD_SLUG)) return true;
  if (typeof ctx.getProjects === "function") {
    var projects = ctx.getProjects() || [];
    for (var i = 0; i < projects.length; i++) {
      if (projects[i].slug === LEAD_SLUG) return true;
    }
  }
  return false;
}

function registerLeadProject(ctx) {
  if (hasLeadProject(ctx)) return { ok: true, added: false, reason: "exists" };
  var usersModule = ctx.users || ctx.usersModule;
  var clayCwd = ctx.clayCwd || getDefaultClayCwd();
  var ownerId = ctx.ownerId || resolveLeadOwnerId(ctx.configProjects, usersModule, clayCwd);
  if (!ownerId || !usersModule || typeof usersModule.getLeadMode !== "function") {
    return { ok: true, added: false, reason: "lead_mode_off" };
  }
  if (usersModule.getLeadMode(ownerId) !== true) {
    return { ok: true, added: false, reason: "lead_mode_off", ownerId: ownerId };
  }
  var workspace = ensureLeadWorkspace(clayCwd);
  var added = ctx.addProject(workspace, LEAD_SLUG, LEAD_NAME, null, ownerId, null, { isLead: true });
  return { ok: true, added: !!added, reason: added ? "added" : "exists", ownerId: ownerId };
}

module.exports = {
  LEAD_SLUG: LEAD_SLUG,
  LEAD_NAME: LEAD_NAME,
  getDefaultClayCwd: getDefaultClayCwd,
  getLeadWorkspaceDir: getLeadWorkspaceDir,
  ensureLeadWorkspace: ensureLeadWorkspace,
  findClayProject: findClayProject,
  resolveLeadOwnerId: resolveLeadOwnerId,
  registerLeadProject: registerLeadProject,
};
