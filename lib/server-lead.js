var path = require("path");
var fs = require("fs");
var config = require("./config");
var leadMode = require("./lead-mode");
var projectIdentity = require("./project-identity");

var LEAD_SLUG = "lead";
// Naming per CTO-ORCHESTRATOR-ROADMAP §11.2 (owner decision 2026-08-01):
// one person named Coop; "Lead" is the role label, not a proper name.
// The sidebar renders the role as a separate "Lead" badge, so together
// they read as the roadmap's "Coop — Lead".
var LEAD_NAME = "Coop";
var LEGACY_TERMINAL_STATUSES = {
  completed: true,
  dismissed: true,
  failed: true,
  cancelled: true,
  superseded: true,
};
var LEGACY_QUEUED_STATUSES = {
  queued: true,
  ready: true,
  blocked: true,
  needs_input: true,
  waiting_user: true,
};
var CUTOVER_DIRECTIVE_START = "<!-- lead-project-cutover:start -->";
var CUTOVER_DIRECTIVE_END = "<!-- lead-project-cutover:end -->";
var ROLE_DIRECTIVE_START = "<!-- lead-control-roles:start -->";
var ROLE_DIRECTIVE_END = "<!-- lead-control-roles:end -->";

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
  return path.join(config.CONFIG_DIR, "lead", "workspace");
}

function cutoverDirective() {
  return [
    CUTOVER_DIRECTIVE_START,
    "## Project execution cutover",
    "",
    "Project work must use an explicit target ProjectRef and the typed",
    "cross-project execution binding. Never use Lead-local delegate_task or",
    "plan_task_graph as a fallback. If the canonical target cannot be resolved,",
    "record visible attention and stop; do not create a Lead-workspace worker.",
    "Terminal legacy Lead workers are immutable historical references only.",
    CUTOVER_DIRECTIVE_END,
  ].join("\n");
}

function ensureCutoverDirective(file) {
  var content = fs.readFileSync(file, "utf8");
  var directive = cutoverDirective();
  var start = content.indexOf(CUTOVER_DIRECTIVE_START);
  var end = content.indexOf(CUTOVER_DIRECTIVE_END);
  var updated = content;
  if (start !== -1 && end > start) {
    updated = content.slice(0, start) + directive +
      content.slice(end + CUTOVER_DIRECTIVE_END.length);
  } else {
    updated = content.replace(/\s*$/, "\n\n") + directive + "\n";
  }
  if (updated !== content) fs.writeFileSync(file, updated);
}

function ensureRoleDirective(file) {
  var content = fs.readFileSync(file, "utf8");
  // Replace only the old stock identity; preserve owner-authored instructions.
  var oldIdentity = [
    "You are Coop — one person, two power levels. \"Lead\" is your role",
    "label while lead mode is enabled, not a separate identity: with lead",
    "mode on you own the backlog, routing, gates, and reporting (operating",
    "procedure: the `lead-tick` skill); with it off you are a plain",
    "coordinator (find, triage, switch). Binding rule: you connect, never",
    "gatekeep — handing the boss to a session directly always beats",
    "summarizing in the middle.",
  ].join("\n");
  var updated = content.replace(oldIdentity,
    "This workspace hosts Coop and its resident project coordinators, Council, and Triage.");
  var directive = [ROLE_DIRECTIVE_START, "## Control session roles", "",
    "Use the current server-supplied clay_control_context for your role and bound project.",
    "Coop owns high-level discussion, priorities, planning, and outcome reporting to the owner.",
    "Project coordinators organize authorized work for their exact ProjectRef and report to Coop.",
    "Council and Triage contribute bounded evidence and recommendations.",
    "The owner can continue working directly in ordinary project sessions and request direct access.",
    "Lead mode and existing authorization gates govern management authority; role text does not grant it.",
    "Project launch rules and owner acceptance remain in force. Never replace missing project rules",
    "with this shared workspace's instructions.", ROLE_DIRECTIVE_END].join("\n");
  var start = updated.indexOf(ROLE_DIRECTIVE_START);
  var end = updated.indexOf(ROLE_DIRECTIVE_END);
  if (start !== -1 && end > start) {
    updated = updated.slice(0, start) + directive + updated.slice(end + ROLE_DIRECTIVE_END.length);
  } else updated = updated.replace(/\s*$/, "\n\n") + directive + "\n";
  if (updated !== content) fs.writeFileSync(file, updated);
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
        "# Coop control workspace",
        "",
        "This workspace hosts Coop and its resident project coordinators, Council, and Triage.",
        "",
        "The clay checkout you operate on lives at: " + (clayCwd || getDefaultClayCwd()),
        "Run all `node` commands from that directory (`cd` there first);",
        "this workspace only hosts the Lead's conversation space.",
        "",
      ].join("\n"));
    }
    ensureCutoverDirective(identity);
    ensureRoleDirective(identity);
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
  return leadMode.resolveOwnerId({
    config: { projects: configProjects || [] },
    usersModule: usersModule,
    clayCwd: clayCwd,
  });
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
  var leadModeModule = ctx.leadMode || leadMode;
  var clayCwd = ctx.clayCwd || getDefaultClayCwd();
  var ownerId = ctx.ownerId || resolveLeadOwnerId(ctx.configProjects, usersModule, clayCwd);
  // Coop is a permanent workspace. Lead mode gates only its autonomous
  // powers, so an owner can enable those powers without a daemon restart.
  if (ownerId && usersModule && typeof leadModeModule.getLeadModeState === "function") {
    leadModeModule.getLeadModeState({ usersModule: usersModule, ownerId: ownerId });
  }
  var workspace = ensureLeadWorkspace(clayCwd);
  var added = ctx.addProject(workspace, LEAD_SLUG, LEAD_NAME, null, ownerId, null, { isLead: true });
  return { ok: true, added: !!added, reason: added ? "added" : "exists", ownerId: ownerId };
}

function sessionManager(project) {
  return project && typeof project.getSessionManager === "function" ?
    project.getSessionManager() : project && project.sm;
}

function sessionByStorageId(sm, storageId) {
  var found = null;
  if (!sm || !sm.sessions || !projectIdentity.isSessionStorageId(storageId)) return null;
  sm.sessions.forEach(function (session) {
    if (!found && projectIdentity.sessionStorageId(session) === storageId) found = session;
  });
  return found;
}

function taskById(session, taskId) {
  var tasks = Array.isArray(session && session.orchestrationTasks) ? session.orchestrationTasks : [];
  for (var i = 0; i < tasks.length; i++) if (tasks[i].taskId === taskId) return tasks[i];
  return null;
}

function referenceSession(sm, ref) {
  return ref && ref.projectId === projectIdentity.LEAD_PROJECT_ID ?
    sessionByStorageId(sm, ref.sessionStorageId) : null;
}

function legacyTaskStatus(task, worker) {
  var policy = worker && worker.orchestrationPolicy || {};
  var cutover = policy.legacyLeadCutover || {};
  var execution = policy.portfolioExecution || {};
  return String(cutover.status || task && task.status || execution.status ||
    worker && worker.taskStatus || (worker && worker.isProcessing ? "running" : "unknown"));
}

function inspectLegacyExecution(project, legacyReference) {
  var reference = legacyReference && typeof legacyReference === "object" ? legacyReference : {};
  var sm = sessionManager(project);
  var coordinator = referenceSession(sm, reference.coordinator) ||
    referenceSession(sm, reference.task && {
      projectId: reference.task.projectId,
      sessionStorageId: reference.task.coordinatorSessionStorageId,
    });
  var task = taskById(coordinator, reference.task && reference.task.taskId);
  var worker = referenceSession(sm, reference.worker);
  if (!worker && task) {
    worker = sessionByStorageId(sm, task.workerStorageId || task.workerSessionStorageId);
  }
  if (!coordinator && !worker) return { ok: false, reason: "legacy_reference_not_found" };
  var status = legacyTaskStatus(task, worker);
  var activeProcess = !!(worker && (worker.isProcessing || worker.queryInstance));
  return {
    ok: true,
    sm: sm,
    coordinator: coordinator,
    task: task,
    worker: worker,
    status: status,
    terminal: !!LEGACY_TERMINAL_STATUSES[status],
    queued: !!LEGACY_QUEUED_STATUSES[status] || !worker,
    activeProcess: activeProcess,
  };
}

function cutoverMarker(request, now) {
  return {
    status: "superseded",
    reason: "migrated_to_target_project",
    portfolioTaskId: request.portfolioTaskId,
    bindingRevision: request.bindingRevision,
    targetProject: request.targetProject,
    at: now,
  };
}

function stopLegacyWorker(worker) {
  if (!worker) return;
  worker.taskStopRequested = true;
  if (worker.abortController && typeof worker.abortController.abort === "function") {
    worker.abortController.abort();
  }
  worker.isProcessing = false;
}

function markLegacyWorker(worker, marker) {
  if (!worker) return;
  worker.orchestrationPolicy = Object.assign({}, worker.orchestrationPolicy || {}, {
    legacyLeadCutover: marker,
  });
  var execution = worker.orchestrationPolicy.portfolioExecution;
  if (!execution) return;
  execution.status = "superseded";
  execution.reason = marker.reason;
  execution.updatedAt = marker.at;
}

function markLegacyTask(task, marker) {
  if (!task) return;
  task.status = "cancelled";
  task.statusReason = marker.reason;
  task.legacyLeadMigration = marker;
}

function saveLegacySupersession(state) {
  try {
    if (state.worker) state.sm.saveSessionFile(state.worker);
    if (state.coordinator) state.sm.saveSessionFile(state.coordinator);
    if (state.sm && typeof state.sm.broadcastSessionList === "function") state.sm.broadcastSessionList();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "legacy_supersession_persistence_failed" };
  }
}

function persistLegacySupersession(state, request, options) {
  var opts = options || {};
  if (!state.ok) return state;
  if (state.terminal) return { ok: true, terminal: true, persisted: false };
  if (state.activeProcess && opts.controlledCutover !== true) {
    return { ok: false, reason: "legacy_execution_active", draining: true };
  }
  var timestamp = typeof opts.now === "function" ? opts.now() : Date.now();
  var marker = cutoverMarker(request, timestamp);
  if (state.task && state.task.legacyLeadMigration &&
      state.task.legacyLeadMigration.bindingRevision === request.bindingRevision) {
    return { ok: true, terminal: true, persisted: true, replay: true };
  }
  if (state.activeProcess) stopLegacyWorker(state.worker);
  markLegacyWorker(state.worker, marker);
  markLegacyTask(state.task, marker);
  var saved = saveLegacySupersession(state);
  if (!saved.ok) return saved;
  return { ok: true, terminal: true, persisted: true };
}

function legacyWorkerStatus(session, taskStatuses) {
  var parent = session && session.orchestrationParent;
  var taskId = parent && parent.taskId;
  var task = taskId && taskStatuses[taskId];
  return legacyTaskStatus(task, session);
}

function legacyLeadReferences(project) {
  var sm = sessionManager(project);
  var sessions = sm && sm.sessions;
  var taskStatuses = {};
  var result = [];
  if (!sessions || typeof sessions.forEach !== "function") return result;
  sessions.forEach(function (session) {
    var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
    for (var i = 0; i < tasks.length; i++) taskStatuses[tasks[i].taskId] = tasks[i];
  });
  sessions.forEach(function (session) {
    if (!session || session.coopHome || session.coopChannel || session.loop || session.taskLauncher) return;
    var policy = session.orchestrationPolicy || {};
    var legacyWorker = !!(session.orchestrationParent || session.orchestrationAdoption ||
      policy.legacyLeadCutover);
    if (!legacyWorker) return;
    var status = legacyWorkerStatus(session, taskStatuses);
    if (!LEGACY_TERMINAL_STATUSES[status]) return;
    var ref = projectIdentity.sessionRef({ projectId: projectIdentity.LEAD_PROJECT_ID }, session);
    if (ref) result.push({ session: session, sessionRef: ref, status: status });
  });
  return result;
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
  inspectLegacyExecution: inspectLegacyExecution,
  persistLegacySupersession: persistLegacySupersession,
  legacyLeadReferences: legacyLeadReferences,
};
