// One narrow seam for finite recovered-Thread authorization aliases.

var explicitImplementationDecision =
  require("./coop-thread-lifecycle").explicitImplementationDecision;
var voice = require("./coop-main-ingress-recovery");
var threads = require("./coop-threads-implementation-recovery");
var urbanStayAutoLaunch = require("./coop-urban-stay-autolaunch-recovery");
var urbanStayPolicy = require("./coop-urban-stay-policy-recovery");

function matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) {
  return voice.matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) ||
    threads.matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) ||
    urbanStayAutoLaunch.matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) ||
    urbanStayPolicy.matchesRecoveredRoute(session, event, eventIndex, requestedTopicId);
}

function matchesRecoveredEntry(entry, session, ingressId, event) {
  return voice.matchesRecoveredEntry(entry, session, ingressId, event) ||
    threads.matchesRecoveredEntry(entry, session, ingressId, event) ||
    urbanStayAutoLaunch.matchesRecoveredEntry(entry, session, ingressId, event) ||
    urbanStayPolicy.matchesRecoveredEntry(entry, session, ingressId, event);
}

function decisionForRecoveredEntry(entry, session, ingressId, event) {
  var decision = null;
  if (voice.matchesRecoveredEntry(entry, session, ingressId, event)) {
    decision = explicitImplementationDecision(event.text);
    if (!decision || decision.intent !== "implement" || decision.projectName) return null;
  } else if (threads.matchesRecoveredEntry(entry, session, ingressId, event)) {
    decision = threads.explicitThreadsDecision(event.text);
    if (!decision || decision.intent !== "implement") return null;
  } else if (urbanStayAutoLaunch.matchesRecoveredEntry(entry, session, ingressId, event)) {
    decision = explicitImplementationDecision(event.text);
    if (!decision || decision.intent !== "implement" || decision.projectName !== "Clay") return null;
  } else if (urbanStayPolicy.matchesRecoveredEntry(entry, session, ingressId, event)) {
    decision = urbanStayPolicy.explicitPolicyDecision(event.text);
    if (!decision || decision.intent !== "implement" || decision.projectName !== "Urban Stay") {
      return null;
    }
    return { decision: decision,
      projectRef: { projectId: urbanStayPolicy.URBAN_STAY_PROJECT_ID } };
  } else {
    return null;
  }
  return { decision: decision, projectRef: { projectId: voice.CLAY_PROJECT_ID } };
}

function runMigration(migration, index, ledger, sm) {
  try {
    return migration.migrateProductionFromSessionManager(index, ledger, sm);
  } catch (error) {
    return { ok: false, code: "recovery_migration_exception",
      message: String(error && error.message || error || "unknown recovery failure") };
  }
}

// A terminal failure can never self-heal: it proves the immutable canonical evidence no
// longer matches the pinned fingerprint, so every later restart returns the same code and
// only an owner decision can change the outcome. Every other failure - dependencies not
// loaded yet, persistence, mutable ledger or Thread drift, an exception - may still
// succeed on a later run and is therefore retryable rather than terminal.
var TERMINAL_CODE_SUFFIXES = ["_event_digest_mismatch", "_event_identity_mismatch",
  "_event_route_mismatch", "_event_topic_mismatch", "_event_ambiguous"];

function terminalCode(code) {
  var value = String(code || "");
  for (var i = 0; i < TERMINAL_CODE_SUFFIXES.length; i++) {
    var suffix = TERMINAL_CODE_SUFFIXES[i];
    if (value.length > suffix.length && value.slice(-suffix.length) === suffix) return true;
  }
  return false;
}

function booleanFlag(value) {
  return typeof value === "boolean" ? value : null;
}

// Fallback for a module that does not report noop itself: success plus every change
// flag absent or falsy means the run proved the repair and wrote nothing.
function changedNothing(result) {
  return !(result && (result.decisionBackfilled || result.threadCreated ||
    result.membershipAdded || result.created ||
    typeof result.moved === "number" && result.moved > 0));
}

function migrationEntry(key, result) {
  var ok = !!(result && result.ok === true);
  return {
    key: key,
    ok: ok,
    noop: ok && (typeof result.noop === "boolean" ? result.noop : changedNothing(result)),
    terminal: !ok && terminalCode(result && result.code),
    code: ok ? null : String(result && result.code || "recovery_migration_result_missing"),
    message: result && result.message ? String(result.message) : null,
    migrationId: result && typeof result.migrationId === "string" ? result.migrationId : null,
    decisionBackfilled: booleanFlag(result && result.decisionBackfilled),
    threadCreated: booleanFlag(result && result.threadCreated),
    membershipAdded: booleanFlag(result && result.membershipAdded),
    created: booleanFlag(result && result.created),
    moved: result && typeof result.moved === "number" ? result.moved : null,
  };
}

// Retirement-grade result: success is as legible as failure, so "has this migration
// finished?" is answerable from one startup log line without reading the ledger.
function migrateProductionFromSessionManager(index, ledger, sm) {
  var migrations = [{ key: "voice", migration: voice },
    { key: "threads", migration: threads },
    { key: "urbanStayAutoLaunch", migration: urbanStayAutoLaunch },
    { key: "urbanStayPolicy", migration: urbanStayPolicy }];
  var result = { ok: true, noop: true, migrations: [], failures: [] };
  for (var i = 0; i < migrations.length; i++) {
    var item = migrations[i];
    var migrationResult = runMigration(item.migration, index, ledger, sm) || {
      ok: false, code: "recovery_migration_result_missing",
    };
    var entry = migrationEntry(item.key, migrationResult);
    result[item.key] = migrationResult;
    result.migrations.push(entry);
    if (!entry.noop) result.noop = false;
    if (!entry.ok) {
      result.ok = false;
      result.failures.push({ migration: item.key, code: entry.code,
        terminal: entry.terminal, result: migrationResult });
    }
  }
  return result;
}

module.exports = {
  CLAY_PROJECT_ID: voice.CLAY_PROJECT_ID,
  matchesRecoveredRoute: matchesRecoveredRoute,
  matchesRecoveredEntry: matchesRecoveredEntry,
  decisionForRecoveredEntry: decisionForRecoveredEntry,
  migrateProductionFromSessionManager: migrateProductionFromSessionManager,
};
