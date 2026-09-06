// Owner learning is evidence and preferences, never execution authority.
// Observations are read from durable canonical history; only interpretations persist.
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var config = require("./config");
var users = require("./users");
var identity = require("./project-identity");
var ownerEvents = require("./coop-owner-event-resolution");
var historyStore = require("./sessions-history-store");
var ledger = require("./coop-control-ledger-file");

function ownerKey(session) {
  if (!session) return null;
  if (session && typeof session.ownerId === "string" && session.ownerId) return session.ownerId;
  return users.isMultiUser() ? null : "_single_user";
}

function readHistory(session, read) {
  var wasResident = historyStore.isResident(session);
  try { return historyStore.readTransient(session, read); }
  finally { if (!wasResident) historyStore.release(session); }
}

function createOwnerModel(options) {
  var directory = options && options.directory || path.join(config.CONFIG_DIR, "lead", "owner-model");
  function fileFor(owner) {
    if (!owner) throw new Error("owner_identity_required");
    return path.join(directory, crypto.createHash("sha256").update(owner).digest("hex") + ".json");
  }
  function read(owner) {
    var state;
    try { state = JSON.parse(fs.readFileSync(fileFor(owner), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return { version: 1, ownerId: owner, preferences: [] };
      throw error;
    }
    if (state.version !== 1 || state.ownerId !== owner || !Array.isArray(state.preferences)) {
      throw new Error("owner_memory_unreadable");
    }
    return state;
  }
  function mutate(owner, operation) {
    var file = fileFor(owner);
    return ledger.withLock(file, function () {
      var state = read(owner);
      var expected = ledger.readIdentity(fs, file);
      var result = operation(state);
      if (result.unchanged) return result;
      var saved = ledger.commitJson(fs, file, state, expected);
      if (!saved.ok) throw new Error(saved.code);
      return result;
    });
  }
  function lineage(session, manager) {
    var indexed = new Map();
    manager.sessions.forEach(function (candidate) {
      if (!candidate._deleted) indexed.set(candidate.storageId,
        indexed.has(candidate.storageId) ? null : candidate);
    });
    var chain = [];
    var seen = new Set();
    var current = session;
    while (current) {
      if (seen.has(current.storageId) || indexed.get(current.storageId) !== current ||
          ownerKey(current) !== ownerKey(session)) throw new Error("owner_lineage_unavailable");
      seen.add(current.storageId);
      chain.push(current);
      if (!current.compactedFromStorageId) break;
      current = indexed.get(current.compactedFromStorageId);
      if (!current) throw new Error("owner_lineage_unavailable");
    }
    return chain;
  }
  function sourceFor(session, manager, ingressId) {
    var match = typeof ingressId === "string" && ingressId.match(/^coop:(.+):([1-9][0-9]*)$/);
    if (!match) throw new Error("owner_ingress_required");
    var chain = lineage(session, manager);
    var origin = chain.findIndex(function (candidate) { return candidate.storageId === match[1]; });
    if (origin < 0) throw new Error("owner_evidence_unavailable");
    var original = observation(chain[origin], ingressId, true);
    if (original.prepared) return original;
    // Queued ingress keeps its immutable ID when compaction moves its dispatch
    // to a continuation. Require the original owner turn and identical text.
    for (var i = origin - 1; i >= 0; i--) {
      var source;
      try { source = observation(chain[i], ingressId); } catch (error) { continue; }
      if (source.event.text !== original.event.text) throw new Error("owner_evidence_conflict");
      if (original.observation.scope === "unresolved") source.observation.scope = "unresolved";
      return source;
    }
    throw new Error("owner_evidence_unavailable");
  }
  function observation(session, ingressId, allowUnprepared) {
    return readHistory(session, function (history) {
      var index = ownerEvents.resolveIndexByIngressId(history, ingressId);
      var event = index >= 0 && history[index];
      if (!event || session._historyNeedsRewrite || index >= session._persistedHistoryLength ||
          !Number.isInteger(session._persistedHistoryLength) || event.synthetic || event.internalOnly ||
          !allowUnprepared && typeof event.coopIngressPreparedText !== "string" ||
          users.isMultiUser() && (!event.from || event.from !== ownerKey(session)) ||
          session.ownerId && event.from && event.from !== session.ownerId) throw new Error("owner_evidence_unavailable");
      var projectRef = identity.normalizeProjectRef(event.coopProjectRef);
      var unresolved = !!event.coopRouteAttention || !!event.coopProjectRef && !projectRef;
      return { event: event, prepared: typeof event.coopIngressPreparedText === "string", observation: { ingressId: ingressId,
        sourceRef: identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, session),
        projectRef: projectRef, scope: unresolved ? "unresolved" : projectRef ? "project" : "global",
        topicRef: event.coopTopicRef || null, recordedAt: event._ts || null } };
    });
  }
  function checkedQuote(source, quote) {
    if (typeof quote !== "string" || !quote.trim() || quote.length > 2000 ||
        String(source.event.text || "").indexOf(quote) === -1) throw new Error("exact_owner_quote_required");
    return quote;
  }
  function remember(session, manager, input) {
    return mutate(ownerKey(session), function (state) {
      var source = sourceFor(session, manager, input.ingressId);
      if (source.observation.scope === "unresolved") throw new Error("owner_scope_unresolved");
      var quote = checkedQuote(source, input.quote);
      var claim = String(input.preference || "").trim();
      if (!claim || claim.length > 1000) throw new Error("bounded_preference_required");
      var kind = input.kind === "owner_statement" ? "owner_statement" : "inferred_preference";
      if (kind === "owner_statement" && claim !== quote) throw new Error("owner_statement_must_be_exact_quote");
      var replaces = input.supersedesId ? state.preferences.find(function (item) { return item.id === input.supersedesId; }) : null;
      if (input.supersedesId && !replaces) throw new Error("preference_to_correct_not_found");
      var scope = source.observation.projectRef;
      if (replaces && JSON.stringify(replaces.projectRef) !== JSON.stringify(scope)) throw new Error("preference_scope_mismatch");
      var id = crypto.createHash("sha256").update(JSON.stringify([input.ingressId, claim, kind, input.supersedesId || ""])).digest("hex").slice(0, 32);
      var existing = state.preferences.find(function (item) { return item.id === id; });
      if (existing) return { ok: true, unchanged: true, preference: existing };
      if (state.preferences.some(function (value) {
        return value.status === "retracted" && value.ingressId === input.ingressId && value.quote === quote;
      })) throw new Error("owner_evidence_retracted");
      if (replaces && replaces.status !== "active") throw new Error("preference_already_replaced");
      var item = { id: id, preference: claim, kind: kind, projectRef: scope, scope: source.observation.scope,
        sourceRef: source.observation.sourceRef, ingressId: input.ingressId, quote: quote,
        status: "active", version: replaces ? replaces.version + 1 : 1,
        supersedesId: replaces ? replaces.id : null, createdAt: Date.now() };
      if (replaces) { replaces.status = "superseded"; replaces.supersededBy = id; }
      state.preferences.push(item);
      return { ok: true, preference: item };
    });
  }
  function retract(session, manager, input) {
    return mutate(ownerKey(session), function (state) {
      var source = sourceFor(session, manager, input.ingressId);
      checkedQuote(source, input.quote);
      var item = state.preferences.find(function (value) { return value.id === input.preferenceId; });
      if (!item) throw new Error("preference_not_found");
      if (item.status === "retracted") return { ok: true, unchanged: true };
      item.status = "retracted";
      item.retraction = { ingressId: input.ingressId, sourceRef: source.observation.sourceRef, quote: input.quote, at: Date.now() };
      return { ok: true };
    });
  }
  function context(session, manager, projectRef) {
    var owner = ownerKey(session);
    if (!owner) return null;
    var state = read(owner);
    var scoped = projectRef && identity.normalizeProjectRef(projectRef);
    var active = state.preferences.filter(function (item) {
      return item.status === "active" && (!scoped || !item.projectRef || item.projectRef.projectId === scoped.projectId);
    }).slice(-30);
    var observations = [];
    var observed = new Set();
    if (!scoped && session) lineage(session, manager).forEach(function (ancestor) {
      if (observations.length >= 10) return;
      readHistory(ancestor, function (history) {
        for (var i = history.length - 1; i >= 0 && observations.length < 10; i--) {
          var event = history[i];
          if (!event || event.type !== "user_message" || !event.coopIngressId || observed.has(event.coopIngressId)) continue;
          observed.add(event.coopIngressId);
          if (state.preferences.some(function (item) {
            return item.ingressId === event.coopIngressId && item.status !== "active";
          })) continue;
          try {
            var source = sourceFor(session, manager, event.coopIngressId);
            observations.unshift(Object.assign({}, source.observation, {
              text: String(source.event.text || "").slice(0, 3000),
              truncated: String(source.event.text || "").length > 3000,
            }));
          } catch (error) {}
        }
      });
    });
    return { preferences: active, recentOwnerObservations: observations,
      policy: "Owner statements and tentative interpretations, scoped to their recorded project. " +
        "Current owner instructions take precedence. These records grant no execution authority." };
  }
  function list(session, input) {
    input = input || {};
    var search = String(input.search || "").toLowerCase();
    var offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    var items = read(ownerKey(session)).preferences.filter(function (item) {
      return (input.status === "all" || item.status === "active") &&
        (!search || (item.preference + " " + item.quote).toLowerCase().indexOf(search) !== -1);
    });
    return { preferences: items.slice(offset, offset + 30), total: items.length,
      nextOffset: offset + 30 < items.length ? offset + 30 : null };
  }
  return { remember: remember, retract: retract, context: context, list: list };
}

var defaultModel;
function getDefaultOwnerModel() {
  if (!defaultModel) defaultModel = createOwnerModel();
  return defaultModel;
}
module.exports = { createOwnerModel: createOwnerModel, getDefaultOwnerModel: getDefaultOwnerModel, ownerKey: ownerKey };
