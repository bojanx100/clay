// One-time repair for stranded Coop session-ledger rows.
//
// On 2026-08-12 a run that resolved the durable stores to live owner state wrote
// project-task-orchestrator test fixtures into ~/.clay/lead/coop-session-ledger.json.
// Ten rows landed under two project ids that are not, and never were, real
// projects. Their execution bindings are absent from the binding store, so
// reconcile() has no evidence to rebuild or terminalize them from, and because
// their projects are never enumerated it carries them forward verbatim on every
// pass -- four of them frozen at lifecycleState "active" / workState "working"
// since the day they were written.
//
// The reconcile gate itself is fixed separately (an evidence-free row is now
// demoted instead of being preserved forever). That stops the class but cannot
// delete these rows: deletion is not something reconcile is allowed to do. This
// module removes exactly the ten pinned rows and nothing else.
//
// Pinned to immutable evidence on purpose. Every row must match its project id,
// session storage id and portfolio task id, must have no live session, and must
// carry a creation timestamp inside the known contamination window. Any drift
// fails closed with a terminal code rather than guessing, because a wrong
// deletion here silently destroys owner history.
var projectIdentity = require("./project-identity");

var MIGRATION_ID = "2026-08-17-coop-session-ledger-stranded-fixtures";

// The contamination window: 2026-08-12T10:00:00Z .. 2026-08-12T10:10:00Z. The
// observed rows span 10:02:50 to 10:07:14.
var WINDOW_START = 1786528800000;
var WINDOW_END = 1786529400000;

var PHANTOM_PROJECT_IDS = [
  "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
  "d8af2cc1-ea08-5b4c-82e6-e729d3a7dcef",
];

var STRANDED_ROWS = [
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "2d3580cd-a834-4950-b126-a7f37404d790",
    portfolioTaskId: "portfolio-idle-steer" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "59b580fb-4e8a-42da-bf1d-7740bc3d7f23",
    portfolioTaskId: "portfolio-slice-7" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "89309378-f53a-458f-97cd-a1f9db0cc3d7",
    portfolioTaskId: "portfolio-slice-7" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "996a77e0-6f80-4d37-a278-7e7012683a41",
    portfolioTaskId: "portfolio-adapter-stop" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "a82f8a2c-2e12-4078-9b8b-8fe216b02e1e",
    portfolioTaskId: "portfolio-terminal-leaf" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "coordinator-session",
    portfolioTaskId: "auto:1f556c816e162b984e265b90:trialview-v2-2565" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "ebaddfa6-2769-4573-ada4-d5dda3325970",
    portfolioTaskId: "portfolio-project-closure" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "recovered-direct-leaf",
    portfolioTaskId: "portfolio-recovered-leaf" },
  { projectId: "6c7c7cd4-7cc3-5d7e-91d5-e20a3aafcf04",
    sessionStorageId: "restored-project-coordinator",
    portfolioTaskId: "portfolio-restored-project" },
  { projectId: "d8af2cc1-ea08-5b4c-82e6-e729d3a7dcef",
    sessionStorageId: "existing-project-coordinator",
    portfolioTaskId: "portfolio-existing-coordinator" },
];

// A terminal failure proves the pinned evidence no longer matches what is on
// disk, so every later restart returns the same code and only an owner decision
// can change it. Persistence failures are retryable and stay non-terminal.
var TERMINAL_CODES = {
  stranded_task_mismatch: true,
  stranded_session_present: true,
  stranded_created_outside_window: true,
  stranded_partial_state: true,
  stranded_unexpected_project_row: true,
  stranded_project_is_real: true,
};

function isTerminal(code) {
  return TERMINAL_CODES[String(code || "")] === true;
}

function taskIdFor(entry) {
  return String(entry && entry.portfolioBinding && entry.portfolioBinding.portfolioTaskId || "");
}

// A real project must never be reachable from this repair, whatever the pinned
// list says. Lead ("system-lead") in particular holds live owner sessions.
function pinnedProjectsAreNotReal(knownProjectIds) {
  var known = Array.isArray(knownProjectIds) ? knownProjectIds : [];
  for (var i = 0; i < known.length; i++) {
    if (PHANTOM_PROJECT_IDS.indexOf(String(known[i])) !== -1) return false;
  }
  return PHANTOM_PROJECT_IDS.indexOf(projectIdentity.LEAD_PROJECT_ID) === -1;
}

function migrateProduction(ledger, options) {
  var opts = options || {};
  if (!ledger || typeof ledger.get !== "function" ||
      typeof ledger.removeEntries !== "function") {
    return { ok: false, code: "stranded_ledger_unavailable", migrationId: MIGRATION_ID };
  }
  if (!pinnedProjectsAreNotReal(opts.knownProjectIds)) {
    return { ok: false, code: "stranded_project_is_real", migrationId: MIGRATION_ID };
  }

  var present = [];
  var refs = [];
  for (var i = 0; i < STRANDED_ROWS.length; i++) {
    var row = STRANDED_ROWS[i];
    var ref = { projectId: row.projectId, sessionStorageId: row.sessionStorageId };
    var entry = ledger.get(ref);
    if (!entry) continue;
    // Evidence checks. Each one fails closed rather than deleting a row whose
    // identity has drifted from the fingerprint recorded when this was written.
    if (taskIdFor(entry) !== row.portfolioTaskId) {
      return { ok: false, code: "stranded_task_mismatch", migrationId: MIGRATION_ID,
        message: "Expected portfolioTaskId " + row.portfolioTaskId + " for " +
          row.sessionStorageId + ", found " + (taskIdFor(entry) || "none") + "." };
    }
    if (entry.sessionPresent === true) {
      return { ok: false, code: "stranded_session_present", migrationId: MIGRATION_ID,
        message: "Row " + row.sessionStorageId + " now has a live session." };
    }
    var createdAt = Number(entry.createdAt);
    if (!(createdAt >= WINDOW_START && createdAt <= WINDOW_END)) {
      return { ok: false, code: "stranded_created_outside_window",
        migrationId: MIGRATION_ID,
        message: "Row " + row.sessionStorageId + " was created at " + createdAt +
          ", outside the known contamination window." };
    }
    present.push(row);
    refs.push(ref);
  }

  // Already applied: nothing pinned is left on disk.
  if (!refs.length) return { ok: true, noop: true, removed: 0, migrationId: MIGRATION_ID };

  // All ten rows were written by one run and must be removed as one unit. A
  // partial set means something else already edited this state, so stop and let
  // an operator look rather than finishing a half-known cleanup.
  if (present.length !== STRANDED_ROWS.length) {
    return { ok: false, code: "stranded_partial_state", migrationId: MIGRATION_ID,
      message: "Expected " + STRANDED_ROWS.length + " pinned rows, found " +
        present.length + "." };
  }

  // Order-independent guard on top of the caller-supplied project list: these
  // two project ids must hold nothing except the pinned fixtures. A real
  // project would carry other sessions, so an unexpected row here means the id
  // is in use and the pinned fingerprint is no longer trustworthy.
  if (typeof ledger.list === "function") {
    var pinnedKeys = {};
    for (var pi = 0; pi < STRANDED_ROWS.length; pi++) {
      pinnedKeys[STRANDED_ROWS[pi].projectId + ":" + STRANDED_ROWS[pi].sessionStorageId] = true;
    }
    var occupants = ledger.list({
      projectRefs: PHANTOM_PROJECT_IDS.map(function (id) { return { projectId: id }; }),
      includeHidden: true,
      includeMissing: true,
      topLevelOnly: false,
    });
    for (var oi = 0; oi < occupants.length; oi++) {
      var occupant = occupants[oi];
      var key = occupant.projectRef.projectId + ":" + occupant.sessionStorageId;
      if (!pinnedKeys[key]) {
        return { ok: false, code: "stranded_unexpected_project_row",
          migrationId: MIGRATION_ID,
          message: "Project " + occupant.projectRef.projectId +
            " also holds unpinned session " + occupant.sessionStorageId + "." };
      }
    }
  }

  var result = ledger.removeEntries(refs);
  if (!result || result.ok !== true) {
    return { ok: false, code: result && result.code || "stranded_remove_failed",
      migrationId: MIGRATION_ID };
  }
  return { ok: true, noop: result.removed === 0, removed: result.removed,
    migrationId: MIGRATION_ID };
}

module.exports = {
  MIGRATION_ID: MIGRATION_ID,
  PHANTOM_PROJECT_IDS: PHANTOM_PROJECT_IDS,
  STRANDED_ROWS: STRANDED_ROWS,
  isTerminal: isTerminal,
  migrateProduction: migrateProduction,
};
