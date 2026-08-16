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

function migrateProductionFromSessionManager(index, ledger, sm) {
  var migrations = [{ key: "voice", migration: voice },
    { key: "threads", migration: threads },
    { key: "urbanStayAutoLaunch", migration: urbanStayAutoLaunch },
    { key: "urbanStayPolicy", migration: urbanStayPolicy }];
  var result = { ok: true, failures: [] };
  for (var i = 0; i < migrations.length; i++) {
    var item = migrations[i];
    var migrationResult = runMigration(item.migration, index, ledger, sm);
    result[item.key] = migrationResult;
    if (!migrationResult || migrationResult.ok !== true) {
      result.ok = false;
      result.failures.push({ migration: item.key, result: migrationResult || {
        ok: false, code: "recovery_migration_result_missing",
      } });
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
