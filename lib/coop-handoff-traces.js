// Durable, privacy-safe runtime evidence for Coop's direct owner handoffs.
//
// This is intentionally a tiny separate artifact rather than session history:
// it stores no owner/assistant text, prompts, or transcript fragments.  A
// pending intent is correlated by an opaque trace id supplied with the later
// navigation action, and every persisted target uses stable project/storage
// identifiers only.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");

var SCHEMA_VERSION = 1;
var DEFAULT_MAX_CASES = 100;
var DEFAULT_INTENT_TTL_MS = 5 * 60 * 1000;
var MAX_ID_LENGTH = 240;
var MAX_OWNER_LENGTH = 240;
var MAX_PROJECT_SLUG_LENGTH = 160;
var MAX_STORAGE_ID_LENGTH = 512;
var liveIntentObservers = new Map();

function defaultTracePath() {
  return path.join(config.CONFIG_DIR, "lead", "gatekeeping-eval-traces.json");
}

function cleanString(value, limit) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

function finiteTime(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeChannel(value) {
  return value === "voice" ? "voice" : "text";
}

function normalizeTarget(value) {
  var target = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  var projectSlug = cleanString(target.projectSlug, MAX_PROJECT_SLUG_LENGTH);
  var sessionStorageId = cleanString(target.sessionStorageId, MAX_STORAGE_ID_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectSlug) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionStorageId)) return null;
  return { projectSlug: projectSlug, sessionStorageId: sessionStorageId };
}

function normalizeOwnerId(value) {
  return cleanString(value, MAX_OWNER_LENGTH) || null;
}

function normalizeTraceId(value) {
  var id = cleanString(value, MAX_ID_LENGTH);
  return /^handoff-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id : null;
}

function normalizeAction(value) {
  return ["switch_session", "navigate_session", "clickable_session_ref"].indexOf(value) >= 0
    ? value : null;
}

function emptyState() {
  return { version: SCHEMA_VERSION, cases: [] };
}

function liveObserverKey(ownerId, intentId) {
  return ownerId + "\u0000" + intentId;
}

function hasOnlyKeys(value, keys) {
  var names = Object.keys(value);
  for (var i = 0; i < names.length; i++) {
    if (keys.indexOf(names[i]) === -1) return false;
  }
  return true;
}

function targetIsNormalized(value) {
  var normalized = normalizeTarget(value);
  return !!normalized && normalized.projectSlug === value.projectSlug &&
    normalized.sessionStorageId === value.sessionStorageId;
}

function assistantEventIsValid(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    hasOnlyKeys(value, ["kind"]) && value.kind === "assistant";
}

function navigationEventIsValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasOnlyKeys(value, ["kind", "action", "target"])) return false;
  if (value.kind !== "navigation" && value.kind !== "handoff") return false;
  return !!normalizeAction(value.action) && targetIsNormalized(value.target);
}

function eventIsValid(value) {
  return assistantEventIsValid(value) || navigationEventIsValid(value);
}

function resolutionIsValid(value) {
  var allowed = ["pending", "navigated", "unmeasurable", "no_match", "rejected_access", "expired", "missing_stable_target"];
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    hasOnlyKeys(value, ["status"]) && allowed.indexOf(value.status) >= 0;
}

function caseScalarsAreValid(value) {
  return !!normalizeTraceId(value.id) && !!normalizeOwnerId(value.ownerId) &&
    value.intent === "direct_owner_handoff" && normalizeChannel(value.channel) === value.channel &&
    (value.expectedTarget === null || targetIsNormalized(value.expectedTarget)) &&
    resolutionIsValid(value.resolution) && finiteTime(value.createdAt) && finiteTime(value.expiresAt) &&
    (value.completedAt === undefined || finiteTime(value.completedAt)) &&
    (value.requiresAssistantObservation === undefined || value.requiresAssistantObservation === true);
}

function traceIsValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !hasOnlyKeys(value, ["events"]) || !Array.isArray(value.events)) return false;
  for (var i = 0; i < value.events.length; i++) {
    if (!eventIsValid(value.events[i])) return false;
  }
  return true;
}

function caseIsValid(value) {
  var keys = ["id", "ownerId", "intent", "channel", "expectedTarget", "resolution", "trace", "createdAt", "expiresAt", "completedAt", "requiresAssistantObservation"];
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    hasOnlyKeys(value, keys) && caseScalarsAreValid(value) && traceIsValid(value.trace);
}

function stateIsValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!hasOnlyKeys(value, ["version", "cases"]) || value.version !== SCHEMA_VERSION || !Array.isArray(value.cases)) return false;
  for (var i = 0; i < value.cases.length; i++) {
    if (!caseIsValid(value.cases[i])) return false;
  }
  return true;
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) return { ok: true, exists: false, state: emptyState() };
  try {
    var parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!stateIsValid(parsed)) return { ok: false, exists: true, reason: "malformed_state" };
    return { ok: true, exists: true, state: parsed };
  } catch (e) {
    return { ok: false, exists: true, reason: "malformed_state" };
  }
}

function syncDirectory(directory) {
  var descriptor = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (e) {
    // Some platforms do not permit syncing directory descriptors. The file
    // itself is already synced before the atomic rename in that case.
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (closeError) {}
    }
  }
}

function writeAtomically(filePath, state) {
  var directory = path.dirname(filePath);
  var tempPath = filePath + ".tmp." + process.pid + "." + crypto.randomUUID();
  var descriptor = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(tempPath, "w", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(state) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
    syncDirectory(directory);
    return { ok: true };
  } catch (e) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (closeError) {}
    }
    try { fs.unlinkSync(tempPath); } catch (unlinkError) {}
    return { ok: false, reason: "persistence_failed" };
  }
}

function isPending(record) {
  return record && record.resolution && record.resolution.status === "pending";
}

function markExpired(records, now) {
  for (var i = 0; i < records.length; i++) {
    if (isPending(records[i]) && records[i].expiresAt <= now) {
      records[i].resolution = { status: "expired" };
      records[i].completedAt = now;
      liveIntentObservers.delete(liveObserverKey(records[i].ownerId, records[i].id));
    }
  }
}

function caseAge(record) {
  return record.completedAt || record.createdAt;
}

function boundedRecords(records, maxCases) {
  if (records.length <= maxCases) return records;
  return records.slice().sort(function (left, right) {
    return caseAge(right) - caseAge(left);
  }).slice(0, maxCases);
}

function copyTarget(target) {
  return target ? { projectSlug: target.projectSlug, sessionStorageId: target.sessionStorageId } : null;
}

function navigationEvent(action, target) {
  return {
    kind: action === "clickable_session_ref" ? "handoff" : "navigation",
    action: action,
    target: copyTarget(target),
  };
}

function assistantEvents(count) {
  var events = [];
  for (var i = 0; i < count; i++) events.push({ kind: "assistant" });
  return events;
}

function evaluatorEvent(event) {
  return event.kind === "assistant" ? { kind: "assistant" } : navigationEvent(event.action, event.target);
}

function caseForEvaluator(record, now) {
  var resolution = record.resolution;
  if (resolution.status === "pending" && record.expiresAt <= now) resolution = { status: "expired" };
  return {
    id: record.id,
    intent: { kind: record.intent },
    channel: record.channel,
    expectedTarget: copyTarget(record.expectedTarget),
    evidenceSource: "runtime_trace",
    resolution: { status: resolution.status },
    trace: { events: record.trace.events.map(evaluatorEvent) },
    evidence: [{ kind: "runtime_trace", status: resolution.status }],
  };
}

function createStore(options) {
  var opts = options || {};
  var filePath = opts.filePath || defaultTracePath();
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var maxCases = typeof opts.maxCases === "number" ? opts.maxCases : DEFAULT_MAX_CASES;
  var ttlMs = typeof opts.intentTtlMs === "number" ? opts.intentTtlMs : DEFAULT_INTENT_TTL_MS;
  var makeId = typeof opts.makeId === "function" ? opts.makeId : function () {
    return "handoff-" + crypto.randomUUID();
  };

  function currentTime() {
    var value = now();
    return finiteTime(value) ? value : Date.now();
  }

  function observerKey(record) {
    return liveObserverKey(record.ownerId, record.id);
  }

  function registerObserver(record, observer) {
    if (record.requiresAssistantObservation && typeof observer === "function") {
      liveIntentObservers.set(observerKey(record), observer);
    }
  }

  function assistantTurns(record) {
    if (!record.requiresAssistantObservation) return 0;
    var observer = liveIntentObservers.get(observerKey(record));
    if (typeof observer !== "function") return null;
    try {
      var count = observer();
      return typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
    } catch (e) {
      return null;
    }
  }

  function mutate(change) {
    var loaded = readState(filePath);
    if (!loaded.ok) return loaded;
    var at = currentTime();
    markExpired(loaded.state.cases, at);
    var result = change(loaded.state.cases, at);
    if (!result || result.ok === false) return result || { ok: false, reason: "invalid_operation" };
    loaded.state.cases = boundedRecords(loaded.state.cases, maxCases);
    var persisted = writeAtomically(filePath, loaded.state);
    return persisted.ok ? result : persisted;
  }

  function recordIntent(input) {
    var ownerId = normalizeOwnerId(input && input.ownerId);
    var expectedTarget = input && input.expectedTarget ? normalizeTarget(input.expectedTarget) : null;
    var intentId = normalizeTraceId(input && input.id) || normalizeTraceId(makeId());
    if (!ownerId || !intentId || (input && input.expectedTarget && !expectedTarget)) {
      return { ok: false, reason: "invalid_intent" };
    }
    var requiresAssistantObservation = input && input.requiresAssistantObservation === true;
    var recorded = mutate(function (records, at) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].id === intentId && records[i].ownerId === ownerId) {
          return { ok: true, id: intentId, reused: true };
        }
      }
      records.push({
        id: intentId,
        ownerId: ownerId,
        intent: "direct_owner_handoff",
        channel: normalizeChannel(input && input.channel),
        expectedTarget: expectedTarget,
        resolution: { status: "pending" },
        trace: { events: [] },
        createdAt: at,
        expiresAt: at + ttlMs,
        requiresAssistantObservation: requiresAssistantObservation || undefined,
      });
      return { ok: true, id: intentId };
    });
    if (recorded && recorded.ok) {
      registerObserver({ id: intentId, ownerId: ownerId, requiresAssistantObservation: requiresAssistantObservation },
        input && input.observeAssistantTurns);
    }
    return recorded;
  }

  function findPending(records, input) {
    var id = normalizeTraceId(input && input.intentId);
    var ownerId = normalizeOwnerId(input && input.ownerId);
    if (!id || !ownerId) return null;
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id && records[i].ownerId === ownerId && isPending(records[i])) return records[i];
    }
    return null;
  }

  function recordResolution(input, status, action) {
    var target = input && input.target ? normalizeTarget(input.target) : null;
    if (action && (!target || !normalizeAction(action))) return { ok: false, reason: "invalid_navigation" };
    var result = mutate(function (records, at) {
      var record = findPending(records, input);
      if (!record) return { ok: false, reason: "no_matching_intent" };
      if (action) {
        var count = action === "clickable_session_ref" ? 0 : assistantTurns(record);
        if (count === null) status = "unmeasurable";
        if (!record.expectedTarget) record.expectedTarget = target;
        record.trace.events = assistantEvents(count || 0).concat([navigationEvent(action, target)]);
      }
      record.resolution = { status: status };
      record.completedAt = at;
      return { ok: true, id: record.id };
    });
    if (result && result.ok) {
      liveIntentObservers.delete(liveObserverKey(normalizeOwnerId(input && input.ownerId), normalizeTraceId(input && input.intentId)));
    }
    return result;
  }

  function recordNavigation(input) {
    return recordResolution(input, "navigated", normalizeAction(input && input.action));
  }

  function recordNoMatch(input) {
    return recordResolution(input, "no_match", null);
  }

  function recordRejectedAccess(input) {
    return recordResolution(input, "rejected_access", null);
  }

  function recordMissingStableTarget(input) {
    return recordResolution(input, "missing_stable_target", null);
  }

  function loadRuntimeTrace() {
    var loaded = readState(filePath);
    if (!loaded.ok) return loaded;
    var at = currentTime();
    return {
      ok: true,
      exists: loaded.exists,
      cases: loaded.state.cases.map(function (record) { return caseForEvaluator(record, at); }),
    };
  }

  return {
    filePath: filePath,
    recordIntent: recordIntent,
    recordNavigation: recordNavigation,
    recordNoMatch: recordNoMatch,
    recordRejectedAccess: recordRejectedAccess,
    recordMissingStableTarget: recordMissingStableTarget,
    loadRuntimeTrace: loadRuntimeTrace,
  };
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  DEFAULT_MAX_CASES: DEFAULT_MAX_CASES,
  DEFAULT_INTENT_TTL_MS: DEFAULT_INTENT_TTL_MS,
  defaultTracePath: defaultTracePath,
  createStore: createStore,
  normalizeTarget: normalizeTarget,
};
