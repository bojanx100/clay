// Durable, reference-only topic lenses over the one canonical Coop transcript.
// Topic state deliberately stores metadata and canonical event references only.

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var completeTurns = require("./coop-topic-extraction").completeTurns;
var topicClassification = require("./coop-topic-classification");
var topicMigration = require("./coop-topic-migration");
var topicProjection = require("./coop-topic-projection");
var topicPromotion = require("./coop-topic-promotion");
var indexMigrations = require("./coop-topic-index-migrations");

var SCHEMA_VERSION = 1;
var RETRO_VERSION = 3;
var DEFAULT_FILE = path.join(config.CONFIG_DIR, "lead", "coop-topic-index.json");
var CLAY_PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var TOPIC_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
var MAX_TITLE = 160;

var SEEDS = [
  { id: "codex-authentication", title: "Codex authentication", group: "uncategorised", words: ["codex", "auth", "login", "logged", "credential", "token"] },
  { id: "coop-conversation-architecture", title: "Coop conversation architecture", group: "cross_project", words: ["coop", "lead", "canonical", "conversation", "channel", "projectref"] },
  { id: "navigation-session-restoration", title: "Navigation and session restoration", group: "clay", words: ["navigation", "session", "restore", "restored", "switch", "back", "forward"] },
  { id: "queued-message-recovery", title: "Queued-message recovery", group: "cross_project", words: ["queue", "queued", "reconnect", "resume", "recovery", "ingress"] },
  { id: "worker-lifecycle-completion", title: "Worker lifecycle and completion", group: "cross_project", words: ["worker", "coordinator", "completion", "completed", "binding", "task"] },
  { id: "clay-sidebar-hierarchy", title: "Clay sidebar hierarchy", group: "clay", words: ["sidebar", "hierarchy", "desktop", "mobile", "lens"] },
  { id: "webapp-triage-session-cleanup", title: "Webapp triage and session cleanup", group: "webapp", words: ["webapp", "triage", "cleanup", "clean up"] },
  { id: "uncategorised-conversations", title: "Uncategorised conversations", group: "uncategorised", words: [], catchAll: true },
];

function cleanTitle(value) {
  var title = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return title.slice(0, MAX_TITLE);
}

function topicId(value) {
  return typeof value === "string" && TOPIC_ID_RE.test(value) ? value : null;
}

function topicRef(value) {
  var id = topicId(value && value.topicId);
  return id ? { topicId: id } : null;
}

function canonicalEventRef(storageId, eventIndex) {
  if (!projectIdentity.isSessionStorageId(storageId) || !Number.isInteger(eventIndex) || eventIndex < 0) return null;
  return { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId, eventIndex: eventIndex };
}

function eventKey(ref) {
  return ref.projectId + ":" + ref.sessionStorageId + ":" + ref.eventIndex;
}

function normalizeEventRef(value, storageId) {
  var ref = value && typeof value === "object" ? value : {};
  if (ref.projectId && ref.projectId !== projectIdentity.LEAD_PROJECT_ID) return null;
  if (storageId && ref.sessionStorageId && ref.sessionStorageId !== storageId) return null;
  return canonicalEventRef(ref.sessionStorageId || storageId, ref.eventIndex);
}

function normalizeGroup(value) {
  var group = value && typeof value === "object" ? value : { kind: value };
  var kind = group.kind || group.type;
  if (kind === "cross_project") return { kind: "cross_project" };
  if (kind === "uncategorised") return { kind: "uncategorised" };
  var projectRef = projectIdentity.normalizeProjectRef(group.projectRef || group);
  return projectRef ? { kind: "project", projectRef: projectRef } : null;
}

function initialState() {
  return { schemaVersion: SCHEMA_VERSION, canonicalSessionStorageId: null, topics: {}, retro: { version: RETRO_VERSION, completedEventCount: 0 } };
}

function validState(value) {
  return value && value.schemaVersion === SCHEMA_VERSION && value.topics && typeof value.topics === "object";
}

function copyRef(ref) {
  return JSON.parse(JSON.stringify(ref));
}

function projectRefForSlug(projects, slug) {
  var list = Array.isArray(projects) ? projects : [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var status = item && typeof item.getStatus === "function" ? item.getStatus() : item || {};
    if (String(status.slug || item && item.slug || "").toLowerCase() !== slug) continue;
    var ref = projectIdentity.projectRef(item && item.projectId || status.projectId);
    if (ref) return ref;
  }
  return null;
}

function seedGroup(seed, options) {
  if (seed.group === "cross_project" || seed.group === "uncategorised") return normalizeGroup(seed.group);
  if (seed.group === "webapp") return normalizeGroup({ projectRef: projectRefForSlug(options.projects, "webapp") }) || normalizeGroup("uncategorised");
  return normalizeGroup({ projectRef: options.clayProjectRef || { projectId: CLAY_PROJECT_ID } });
}

function makeTopic(id, title, group, source, now, keywords) {
  return {
    topicRef: { topicId: id }, title: title, group: group, source: source,
    keywords: Array.isArray(keywords) ? keywords.slice(0, 8) : [],
    status: "open", createdAt: now, updatedAt: now, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
}

function matchesSeed(text, seed) {
  var value = String(text || "").toLowerCase();
  if (!value || seed.catchAll) return false;
  for (var i = 0; i < seed.words.length; i++) if (value.indexOf(seed.words[i]) !== -1) return true;
  return false;
}

function canonicalTurnRef(storageId, startEventIndex, endEventIndex) {
  if (!projectIdentity.isSessionStorageId(storageId) || !Number.isInteger(startEventIndex) ||
      !Number.isInteger(endEventIndex) || startEventIndex < 0 || endEventIndex < startEventIndex) return null;
  return { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: storageId, startEventIndex: startEventIndex, endEventIndex: endEventIndex };
}

function turnKey(ref) {
  return ref.projectId + ":" + ref.sessionStorageId + ":" + ref.startEventIndex + ":" + ref.endEventIndex;
}

function hasTurn(topic, ref) {
  var refs = Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
  var key = turnKey(ref);
  for (var i = 0; i < refs.length; i++) if (turnKey(refs[i]) === key) return true;
  return false;
}

function mergeTurnRefs(topic, refs) {
  if (!Array.isArray(topic.turnRefs)) topic.turnRefs = [];
  var changed = false;
  for (var i = 0; i < refs.length; i++) {
    if (!hasTurn(topic, refs[i])) { topic.turnRefs.push(copyRef(refs[i])); changed = true; }
  }
  topic.turnRefs.sort(function (a, b) { return a.startEventIndex - b.startEventIndex; });
  return changed;
}

function hasEvent(topic, ref) {
  var key = eventKey(ref);
  for (var i = 0; i < topic.eventRefs.length; i++) if (eventKey(topic.eventRefs[i]) === key) return true;
  return false;
}

function mergeRefs(target, refs) {
  var changed = false;
  for (var i = 0; i < refs.length; i++) {
    if (!hasEvent(target, refs[i])) { target.eventRefs.push(copyRef(refs[i])); changed = true; }
  }
  target.eventRefs.sort(function (a, b) { return a.eventIndex - b.eventIndex; });
  return changed;
}

function normalizeExecution(value, depth) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return null;
  var result = {};
  var project = projectIdentity.normalizeProjectRef(value.projectRef);
  var session = projectIdentity.normalizeSessionRef(value.sessionRef);
  var task = projectIdentity.normalizeTaskRef(value.taskRef);
  if (project) result.projectRef = project;
  if (session) result.sessionRef = session;
  if (task) result.taskRef = task;
  if (!project && !session && !task) return null;
  if (Array.isArray(value.children)) {
    result.children = value.children.map(function (child) { return normalizeExecution(child, depth + 1); }).filter(Boolean).slice(0, 32);
  }
  return result;
}

// The projection module reduces stored execution links to visible session links
// and needs the same normalizer the durable writes use, so both agree on what a
// valid reference is.
var projectionDeps = { normalizeExecution: normalizeExecution, normalizeGroup: normalizeGroup };

function createTopicIndex(options) {
  var opts = options || {};
  var file = opts.file || DEFAULT_FILE;
  var now = opts.now || function () { return Date.now(); };
  var state = null;

  function classifier(canAccessProject, projects, recentTopic) {
    return {
      seeds: SEEDS, matchesSeed: matchesSeed, normalizeGroup: normalizeGroup, makeTopic: makeTopic,
      now: now, topicRef: topicRef, canAccessProject: canAccessProject,
      projects: projects || [], recentTopic: recentTopic || null,
    };
  }

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { state = initialState(); }
    if (!validState(state)) state = initialState();
    if (!state.retro || typeof state.retro !== "object") state.retro = { version: 0, completedEventCount: 0 };
    var ids = Object.keys(state.topics);
    for (var i = 0; i < ids.length; i++) {
      var topic = state.topics[ids[i]];
      if (!topic || typeof topic !== "object") { delete state.topics[ids[i]]; continue; }
      if (!Array.isArray(topic.eventRefs)) topic.eventRefs = [];
      if (!Array.isArray(topic.turnRefs)) topic.turnRefs = [];
      if (!Array.isArray(topic.relatedExecutions)) topic.relatedExecutions = [];
      if (!Array.isArray(topic.keywords)) topic.keywords = [];
    }
    return state;
  }

  function save() {
    var next = load();
    var dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var temp = file + ".tmp." + process.pid + "." + Date.now();
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch (e) {}
  }

  function resolve(ref, includeClosed) {
    var normalized = topicRef(ref);
    var topic = normalized && load().topics[normalized.topicId];
    if (!topic) return { ok: false, code: "topic_not_found" };
    if (!includeClosed && topic.status !== "open") return { ok: false, code: "topic_closed" };
    return { ok: true, topic: topic, ref: normalized };
  }

  function ensureRetro(session, retroOptions) {
    var storageId = projectIdentity.sessionStorageId(session);
    if (!session || !session.coopHome || !storageId) return { ok: false, code: "canonical_coop_required" };
    var index = load();
    var options = retroOptions || {};
    var expectedStorageId = options.expectedCanonicalStorageId || opts.expectedCanonicalStorageId || null;
    if (expectedStorageId && expectedStorageId !== storageId) return { ok: false, code: "canonical_session_mismatch" };
    if (index.canonicalSessionStorageId && index.canonicalSessionStorageId !== storageId) return { ok: false, code: "canonical_session_mismatch" };
    var changed = topicMigration.prepareRetroUpgrade(index, RETRO_VERSION);
    if (!index.canonicalSessionStorageId) { index.canonicalSessionStorageId = storageId; changed = true; }
    var history = Array.isArray(session.history) ? session.history : [];
    var fromEvent = !changed && index.retro.version === RETRO_VERSION && Number.isInteger(index.retro.completedEventCount) &&
      index.retro.completedEventCount >= 0 && index.retro.completedEventCount <= history.length
      ? index.retro.completedEventCount : 0;
    for (var si = 0; si < SEEDS.length; si++) {
      var seed = SEEDS[si];
      if (!index.topics[seed.id]) {
        index.topics[seed.id] = makeTopic(seed.id, seed.title, seedGroup(seed, options), "automatic", now(), seed.words);
        changed = true;
        fromEvent = 0;
      }
    }
    var extracted = completeTurns(history, fromEvent);
    for (var ti = 0; ti < extracted.turns.length; ti++) {
      var turn = extracted.turns[ti];
      var turnRef = canonicalTurnRef(storageId, turn.startEventIndex, turn.endEventIndex);
      var eventRefs = [canonicalEventRef(storageId, turn.startEventIndex)];
      var recent = topicClassification.mostRecentTopic(index, storageId, turn.startEventIndex);
      var classification = topicClassification.topicsForTurn(index, turn, classifier(null, options.projects, recent));
      if (classification.created) changed = true;
      for (var mi = 0; mi < classification.topics.length; mi++) {
        var member = classification.topics[mi];
        // updatedAt tracks membership exactly: it moves when this topic actually
        // gained an event or turn span, and stays put when it did not. That makes
        // a replay of already-settled history a true no-op -- previously a full
        // reprocess left updatedAt untouched even for genuinely new membership,
        // so "last changed" said nothing and the recency tie-break in
        // bestExisting had no signal to work with.
        var touched = mergeRefs(member, eventRefs);
        if (mergeTurnRefs(member, [turnRef])) touched = true;
        if (touched) {
          member.updatedAt = now();
          changed = true;
        }
      }
    }
    if (index.retro.version !== RETRO_VERSION || index.retro.completedEventCount !== extracted.nextEvent) {
      index.retro.version = RETRO_VERSION;
      index.retro.completedEventCount = extracted.nextEvent;
      changed = true;
    }
    if (changed) save();
    return { ok: true, changed: changed, topics: Object.keys(index.topics).length, eventCount: extracted.nextEvent };
  }

  function createSplitTopic(input) {
    var request = input || {};
    var id = topicId(request.topicId) || "topic-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    var title = cleanTitle(request.title);
    var group = normalizeGroup(request.group || request.projectRef || "uncategorised");
    var index = load();
    if (!title) return { ok: false, code: "invalid_topic_title" };
    if (!group) return { ok: false, code: "invalid_topic_group" };
    if (index.topics[id]) return { ok: false, code: "topic_exists" };
    index.topics[id] = makeTopic(id, title, group, "split", now());
    save();
    return { ok: true, topic: copyRef(index.topics[id]) };
  }

  function rename(ref, title) {
    var result = resolve(ref, true); var next = cleanTitle(title);
    if (!result.ok) return result;
    if (!next) return { ok: false, code: "invalid_topic_title" };
    result.topic.title = next; result.topic.updatedAt = now(); save(); return { ok: true };
  }

  function move(ref, group) {
    var result = resolve(ref, true); var next = normalizeGroup(group);
    if (!result.ok) return result;
    if (!next) return { ok: false, code: "invalid_topic_group" };
    result.topic.group = next; result.topic.updatedAt = now(); save(); return { ok: true };
  }

  function changeStatus(ref, status) {
    var result = resolve(ref, true);
    if (!result.ok) return result;
    // A merged topic is gone for good: its membership now lives in the merge
    // target. Reopening one would resurrect a duplicate lens over turns another
    // topic already owns, so the only way back is through the target.
    if (result.topic.status === "merged" && status === "open") return { ok: false, code: "topic_merged" };
    if (result.topic.status === status) return { ok: true, unchanged: true };
    result.topic.status = status; result.topic.updatedAt = now(); save(); return { ok: true };
  }

  function merge(targetRef, sourceRefs) {
    var target = resolve(targetRef, false); var sources = Array.isArray(sourceRefs) ? sourceRefs : [];
    if (!target.ok) return target;
    var changed = false;
    for (var i = 0; i < sources.length; i++) {
      var source = resolve(sources[i], false);
      if (!source.ok || source.ref.topicId === target.ref.topicId) continue;
      if (mergeRefs(target.topic, source.topic.eventRefs)) changed = true;
      if (mergeTurnRefs(target.topic, source.topic.turnRefs || [])) changed = true;
      if (source.topic.relatedExecutions.length) target.topic.relatedExecutions = target.topic.relatedExecutions.concat(copyRef(source.topic.relatedExecutions));
      source.topic.status = "merged"; source.topic.mergedInto = target.ref; source.topic.updatedAt = now(); changed = true;
    }
    if (changed) { target.topic.updatedAt = now(); save(); }
    return { ok: true, changed: changed };
  }

  function split(sourceRef, parts) {
    var source = resolve(sourceRef, false); var list = Array.isArray(parts) ? parts : [];
    if (!source.ok) return source;
    var created = [];
    for (var i = 0; i < list.length; i++) {
      var part = list[i] || {}; var result = createSplitTopic({ title: part.title, group: part.group || source.topic.group, topicId: part.topicId });
      if (!result.ok) return result;
      var refs = Array.isArray(part.eventRefs) ? part.eventRefs.map(function (ref) { return normalizeEventRef(ref, load().canonicalSessionStorageId); }).filter(Boolean) : [];
      for (var ri = 0; ri < refs.length; ri++) if (!hasEvent(source.topic, refs[ri])) return { ok: false, code: "event_not_in_source" };
      var createdTopic = load().topics[result.topic.topicRef.topicId];
      if (mergeRefs(createdTopic, refs)) { createdTopic.updatedAt = now(); save(); }
      created.push(result.topic.topicRef);
    }
    return { ok: true, topicRefs: created };
  }

  function addEventMembership(ref, refs) {
    var result = resolve(ref, false); var storageId = load().canonicalSessionStorageId;
    if (!result.ok) return result;
    var valid = (Array.isArray(refs) ? refs : []).map(function (value) { return normalizeEventRef(value, storageId); }).filter(Boolean);
    if (valid.length !== (Array.isArray(refs) ? refs.length : 0)) return { ok: false, code: "invalid_event_ref" };
    if (mergeRefs(result.topic, valid)) { result.topic.updatedAt = now(); save(); }
    return { ok: true };
  }

  function linkExecution(ref, execution) {
    var result = resolve(ref, true); var normalized = normalizeExecution(execution, 0);
    if (!result.ok) return result;
    // Closed topics may still gain linked work -- work outlives the decision to
    // close, and that link is how completed work becomes awaiting acceptance
    // rather than silently vanishing. A merged topic cannot: its identity is
    // retired, so a link here would attach live work to a lens nobody reads.
    if (result.topic.status === "merged") return { ok: false, code: "topic_merged" };
    if (!normalized) return { ok: false, code: "invalid_execution_ref" };
    result.topic.relatedExecutions.push(normalized); result.topic.updatedAt = now(); save(); return { ok: true };
  }

  function resolveCanonicalEvent(ref, event) {
    var result = resolve(ref, true); var storageId = load().canonicalSessionStorageId;
    if (!result.ok) return result;
    var canonical = normalizeEventRef(event, storageId);
    if (!canonical) return { ok: false, code: "invalid_event_ref" };
    if (!hasEvent(result.topic, canonical)) return { ok: false, code: "event_not_in_topic" };
    var turnRefs = Array.isArray(result.topic.turnRefs) ? result.topic.turnRefs : [];
    var turnRef = null;
    for (var i = 0; i < turnRefs.length; i++) {
      if (canonical.eventIndex >= turnRefs[i].startEventIndex && canonical.eventIndex <= turnRefs[i].endEventIndex) {
        turnRef = copyRef(turnRefs[i]);
        break;
      }
    }
    return { ok: true, eventRef: canonical, turnRef: turnRef, topicRef: result.ref };
  }

  // Group-level visibility lives in coop-topic-projection: it already owns "what
  // may an actor see" for a single topic, and this is the same question asked of
  // the whole set. Kept on the index as a thin delegation so the public API is
  // unchanged.
  function project(options) {
    return topicProjection.projectTopics(load(), options, projectionDeps);
  }

  function validateIngress(session, message, options) {
    var msg = message || {}; var ref = msg.coopTopicRef || msg.topicRef || null;
    var requestedProject = msg.coopProjectRef || msg.projectRef || null;
    if (!ref && !requestedProject) return { ok: true, topicRef: null, projectRef: null };
    var projectRef = requestedProject ? projectIdentity.normalizeProjectRef(requestedProject) : null;
    if (requestedProject && !projectRef) return { ok: false, code: "invalid_project_ref" };
    if (projectRef && options && typeof options.isProjectAvailable === "function" && !options.isProjectAvailable(projectRef)) return { ok: false, code: "project_target_unavailable" };
    if (!ref) return { ok: true, topicRef: null, projectRef: projectRef };
    var index = load(); var storageId = projectIdentity.sessionStorageId(session);
    if (!session || !session.coopHome || !storageId || index.canonicalSessionStorageId !== storageId) return { ok: false, code: "canonical_coop_required" };
    var includeClosed = !!(options && options.includeClosedTopics);
    var resolved = resolve(ref, includeClosed);
    if (!resolved.ok) return resolved;
    if (resolved.topic.group.kind === "project") {
      if (!projectRef || projectRef.projectId !== resolved.topic.group.projectRef.projectId) return { ok: false, code: "topic_project_mismatch" };
    } else if (projectRef) {
      return { ok: false, code: "topic_project_mismatch" };
    }
    // Durable promotion evidence: the owner aimed new work at this exact lens.
    if (topicPromotion.recordExplicitRoute(resolved.topic, options, includeClosed)) save();
    return { ok: true, topicRef: resolved.ref, projectRef: resolved.topic.group.kind === "project" ? projectRef : null };
  }

  function classifyCanonicalIngress(session, message, options) {
    var msg = message || {};
    var requestedProject = msg.coopProjectRef || msg.projectRef || null;
    var projectRef = requestedProject ? projectIdentity.normalizeProjectRef(requestedProject) : null;
    if (requestedProject && !projectRef) return { ok: false, code: "invalid_project_ref" };
    if (projectRef && options && typeof options.isProjectAvailable === "function" && !options.isProjectAvailable(projectRef)) {
      return { ok: false, code: "project_target_unavailable" };
    }
    var storageId = projectIdentity.sessionStorageId(session);
    var index = load();
    if (!session || !session.coopHome || !storageId || index.canonicalSessionStorageId !== storageId) {
      return { ok: false, code: "canonical_coop_required" };
    }
    var preferredGroup = projectRef ? normalizeGroup({ projectRef: projectRef }) : null;
    var recent = topicClassification.recentHistoryTopic(index, session.history, topicRef);
    var classified = topicClassification.classifyIngress(index, msg.text || "", preferredGroup, classifier(function (ref) {
      return !options || typeof options.isProjectAvailable !== "function" || options.isProjectAvailable(ref);
    }, options && options.projects, recent));
    if (!classified.ok) return classified;
    if (classified.created) save();
    var inferredProject = classified.topic.group.kind === "project" ? classified.topic.group.projectRef : null;
    // The routing decision, named. `created` alone cannot distinguish a small
    // conversational turn (which must never staff execution) from a genuine
    // reuse of an existing topic -- both leave `created` false.
    return { ok: true, topicRef: copyRef(classified.topic.topicRef), projectRef: copyRef(inferredProject),
      created: classified.created,
      classification: topicClassification.lowInformation(msg.text || "")
        ? "conversational" : (classified.created ? "new_topic" : "existing_topic") };
  }

  // Anchor reconciliation, standalone title retrofit, the exactly-once
  // migrations and the durable owner-disposition writer live in
  // coop-topic-index-migrations.js (module-size split); they operate on this
  // instance through the seam below and share its load/save/now/resolve.
  var migrationSeam = { load: load, save: save, now: now, resolve: resolve };

  function reconcileTopicAnchors(session) {
    return indexMigrations.reconcileTopicAnchors(migrationSeam, session);
  }

  function retrofitTopicTitles(session) {
    return indexMigrations.retrofitTopicTitles(migrationSeam, session);
  }

  function ensureTitleRetrofit(session) {
    return indexMigrations.ensureTitleRetrofit(migrationSeam, session);
  }

  function ensureDispositionBackfill(session) {
    return indexMigrations.ensureDispositionBackfill(migrationSeam, session);
  }

  function applyTopicDisposition(ref, decision) {
    return indexMigrations.applyTopicDisposition(migrationSeam, ref, decision);
  }

  function ensureTopicConsolidation(session) { return indexMigrations.ensureTopicConsolidation(migrationSeam, session); }
  function proposeTopicClosures(session, options) { return indexMigrations.proposeTopicClosures(migrationSeam, session, options); }
  function confirmTopicClosures(decision, evidence) { return indexMigrations.confirmTopicClosures(migrationSeam, decision, evidence); }

  return { load: load, save: save, ensureRetro: ensureRetro, reconcileTopicAnchors: reconcileTopicAnchors, retrofitTopicTitles: retrofitTopicTitles, ensureTitleRetrofit: ensureTitleRetrofit, ensureDispositionBackfill: ensureDispositionBackfill, ensureTopicConsolidation: ensureTopicConsolidation, proposeTopicClosures: proposeTopicClosures, confirmTopicClosures: confirmTopicClosures, applyTopicDisposition: applyTopicDisposition, rename: rename, move: move, merge: merge, split: split, close: function (ref) { return changeStatus(ref, "closed"); }, reopen: function (ref) { return changeStatus(ref, "open"); }, addEventMembership: addEventMembership, linkExecution: linkExecution, resolveCanonicalEvent: resolveCanonicalEvent, project: project, validateIngress: validateIngress, classifyCanonicalIngress: classifyCanonicalIngress, resolve: resolve, file: file };
}

var defaultIndex = null;
function getDefaultTopicIndex() {
  if (!defaultIndex) defaultIndex = createTopicIndex();
  return defaultIndex;
}

module.exports = { createTopicIndex: createTopicIndex, getDefaultTopicIndex: getDefaultTopicIndex, topicRef: topicRef, canonicalEventRef: canonicalEventRef, normalizeGroup: normalizeGroup, CLAY_PROJECT_ID: CLAY_PROJECT_ID, SEEDS: SEEDS };
