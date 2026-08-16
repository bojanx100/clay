// One narrow seam for finite recovered-Thread authorization aliases.

var explicitImplementationDecision =
  require("./coop-thread-lifecycle").explicitImplementationDecision;
var voice = require("./coop-main-ingress-recovery");
var threads = require("./coop-threads-implementation-recovery");
var urbanStayAutoLaunch = require("./coop-urban-stay-autolaunch-recovery");

function matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) {
  return voice.matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) ||
    threads.matchesRecoveredRoute(session, event, eventIndex, requestedTopicId) ||
    urbanStayAutoLaunch.matchesRecoveredRoute(session, event, eventIndex, requestedTopicId);
}

function matchesRecoveredEntry(entry, session, ingressId, event) {
  return voice.matchesRecoveredEntry(entry, session, ingressId, event) ||
    threads.matchesRecoveredEntry(entry, session, ingressId, event) ||
    urbanStayAutoLaunch.matchesRecoveredEntry(entry, session, ingressId, event);
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
  } else {
    return null;
  }
  return { decision: decision, projectRef: { projectId: voice.CLAY_PROJECT_ID } };
}

function migrateProductionFromSessionManager(index, ledger, sm) {
  var voiceResult = voice.migrateProductionFromSessionManager(index, ledger, sm);
  if (!voiceResult.ok) return { ok: false, migration: "voice", result: voiceResult };
  var threadsResult = threads.migrateProductionFromSessionManager(index, ledger, sm);
  if (!threadsResult.ok) return { ok: false, migration: "threads", result: threadsResult };
  var urbanStayResult = urbanStayAutoLaunch.migrateProductionFromSessionManager(index, ledger, sm);
  if (!urbanStayResult.ok) {
    return { ok: false, migration: "urban_stay_autolaunch", result: urbanStayResult };
  }
  return { ok: true, voice: voiceResult, threads: threadsResult, urbanStayAutoLaunch: urbanStayResult };
}

module.exports = {
  CLAY_PROJECT_ID: voice.CLAY_PROJECT_ID,
  matchesRecoveredRoute: matchesRecoveredRoute,
  matchesRecoveredEntry: matchesRecoveredEntry,
  decisionForRecoveredEntry: decisionForRecoveredEntry,
  migrateProductionFromSessionManager: migrateProductionFromSessionManager,
};
