// Durable, reference-only lenses over the canonical Coop transcript.
var crypto = require("crypto");
var path = require("path");
var config = require("./config");
var projectIdentity = require("./project-identity");
var completeTurns = require("./coop-topic-extraction").completeTurns;
var topicClassification = require("./coop-topic-classification");
var topicMigration = require("./coop-topic-migration");
var topicProjection = require("./coop-topic-projection");
var topicPromotion = require("./coop-topic-promotion");
var topicTitleRefinement = require("./coop-topic-title-refinement");
var indexMigrations = require("./coop-topic-index-migrations");
var lineage = require("./coop-topic-lineage");
var threadLifecycle = require("./coop-thread-lifecycle");
var automationThread = require("./coop-automation-thread");
var ownerThread = require("./coop-owner-thread");
var createTopicIndexStore = require("./coop-topic-index-store").createTopicIndexStore;
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
  var id = topicId(value && (value.topicId || value.threadId));
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
  var allowed = arguments[2] && typeof arguments[2] === "object" ? arguments[2] : null;
  if (storageId && ref.sessionStorageId && ref.sessionStorageId !== storageId &&
      !(allowed && allowed[ref.sessionStorageId])) return null;
  var sessionStorageId = ref.sessionStorageId || storageId;
  if (allowed && sessionStorageId && !allowed[sessionStorageId]) return null;
  return canonicalEventRef(sessionStorageId, ref.eventIndex);
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
  return { schemaVersion: SCHEMA_VERSION, canonicalSessionStorageId: null, topics: {}, threadLifecycleVersion: 1,
    threadCorrections: [], titleRefinementVersion: topicTitleRefinement.REFINEMENT_VERSION,
    retro: { version: RETRO_VERSION, completedEventCount: 0, bySession: {} } };
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
  var topic = {
    topicRef: { topicId: id }, title: title, group: group, source: source,
    keywords: Array.isArray(keywords) ? keywords.slice(0, 8) : [],
    status: "open", createdAt: now, updatedAt: now, eventRefs: [], turnRefs: [], relatedExecutions: [],
  };
  threadLifecycle.initializeThread(topic, now, id);
  return topic;
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

function topicGroupKey(group) {
  if (group && group.kind === "project" && group.projectRef) return "project:" + group.projectRef.projectId;
  return group && group.kind || "uncategorised";
}

// Only converge rows with the same durable opening turn. A shared title or
// keyword is not enough: a renamed/manual/handed-off row, a closed decision,
// or a row with linked work remains a separate auditable identity. Legacy rows
// get their identity from the first proven turn span; new rows carry the same
// evidence explicitly in threadIdentity.
function titleOnlyIdentityCandidate(topic) {
  if (!topic || topic.source !== "automatic" || topic.status !== "open") return false;
  var id = topic.topicRef && topic.topicRef.topicId;
  if (typeof id !== "string" || !/^auto-[a-f0-9]{24}$/.test(id)) return false;
  if (topic.titleManuallySet === true || topic.titleRefinement && topic.titleRefinement.manual === true) return false;
  if (topic.threadState && topic.threadState !== threadLifecycle.THREAD_STATES.EXPLORING) return false;
  if (topic.explicitlyRouted === true || topic.ownerDisposition && topic.ownerDisposition.status) return false;
  if (Array.isArray(topic.relatedExecutions) && topic.relatedExecutions.length) return false;
  return true;
}

function identityConvergence(index, now) {
  var topics = index && index.topics || {};
  var ids = Object.keys(topics).sort();
  var buckets = {};
  for (var i = 0; i < ids.length; i++) {
    var topic = topics[ids[i]];
    if (!titleOnlyIdentityCandidate(topic)) continue;
    var identity = topicClassification.topicIdentityKey(topic);
    if (!identity) continue;
    var key = topicGroupKey(topic.group) + "\n" + identity;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(topic);
  }
  var keys = Object.keys(buckets).sort();
  var changed = 0;
  for (var bi = 0; bi < keys.length; bi++) {
    var candidates = buckets[keys[bi]];
    if (candidates.length < 2) {
      if (candidates.length === 1 && !candidates[0].threadIdentity) {
        var ref = (candidates[0].turnRefs || []).slice().sort(function (left, right) {
          return left.startEventIndex - right.startEventIndex;
        })[0];
        if (ref) candidates[0].threadIdentity = {
          schemaVersion: 1, kind: "canonical_turn",
          eventRef: { projectId: projectIdentity.LEAD_PROJECT_ID,
            sessionStorageId: ref.sessionStorageId, eventIndex: ref.startEventIndex },
        };
        if (ref) changed += 1;
      }
      continue;
    }
    candidates.sort(function (left, right) {
      var leftStable = left.threadIdentity && left.threadIdentity.eventRef ? 0 : 1;
      var rightStable = right.threadIdentity && right.threadIdentity.eventRef ? 0 : 1;
      return leftStable - rightStable || left.topicRef.topicId.localeCompare(right.topicRef.topicId);
    });
    var target = candidates[0];
    if (!target.threadIdentity) {
      var targetRef = (target.turnRefs || []).slice().sort(function (left, right) {
        return left.startEventIndex - right.startEventIndex;
      })[0];
      if (targetRef) target.threadIdentity = {
        schemaVersion: 1, kind: "canonical_turn",
        eventRef: { projectId: projectIdentity.LEAD_PROJECT_ID,
          sessionStorageId: targetRef.sessionStorageId, eventIndex: targetRef.startEventIndex },
      };
      if (targetRef) changed += 1;
    }
    for (var ci = 1; ci < candidates.length; ci++) {
      var source = candidates[ci];
      var result = threadLifecycle.mergeThreads({
        load: function () { return index; }, save: function () {}, now: now,
      }, target.topicRef, [source.topicRef], {
        ownerRequestCorrections: [{ kind: "canonical_lineage_identity_convergence", identity: keys[bi] }],
      });
      if (result.ok) changed += 1;
    }
  }
  return changed;
}

function membershipStorageIds(topic, canonicalStorageId) {
  var allowed = {};
  var eventRefs = Array.isArray(topic && topic.eventRefs) ? topic.eventRefs : [];
  var turnRefs = Array.isArray(topic && topic.turnRefs) ? topic.turnRefs : [];
  if (canonicalStorageId) allowed[canonicalStorageId] = true;
  for (var i = 0; i < eventRefs.length; i++) {
    if (eventRefs[i] && eventRefs[i].sessionStorageId) allowed[eventRefs[i].sessionStorageId] = true;
  }
  for (var ti = 0; ti < turnRefs.length; ti++) {
    if (turnRefs[ti] && turnRefs[ti].sessionStorageId) allowed[turnRefs[ti].sessionStorageId] = true;
  }
  return allowed;
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

// Projection and durable writes share the same execution/group normalizers.
var projectionDeps = { normalizeExecution: normalizeExecution, normalizeGroup: normalizeGroup };
function createTopicIndex(options) {
  var opts = options || {};
  var file = opts.file || DEFAULT_FILE;
  var now = opts.now || function () { return Date.now(); };
  var store = createTopicIndexStore({
    file: file, fs: opts.fs, initialState: initialState, validState: validState,
    lockOptions: opts.lockOptions,
  });
  var load = store.load;
  var save = store.save;
  var mutate = store.mutate;

  function classifier(canAccessProject, projects, recentTopic) {
    return {
      seeds: SEEDS, matchesSeed: matchesSeed, normalizeGroup: normalizeGroup, makeTopic: makeTopic,
      now: now, topicRef: topicRef, canAccessProject: canAccessProject,
      projects: projects || [], recentTopic: recentTopic || null,
    };
  }
  function sessionMatchesCanonical(session, canonicalStorageId) {
    return lineage.sessionExtendsCanonical(session, canonicalStorageId);
  }
  function retroCursor(index, storageId, historyLength) {
    var retro = index && index.retro || {};
    var bySession = retro.bySession && typeof retro.bySession === "object" ? retro.bySession : {};
    var sessionCursor = bySession[storageId];
    if (Number.isInteger(sessionCursor) && sessionCursor >= 0 && sessionCursor <= historyLength) return sessionCursor;
    if (storageId === index.canonicalSessionStorageId &&
        Number.isInteger(retro.completedEventCount) &&
        retro.completedEventCount >= 0 && retro.completedEventCount <= historyLength) {
      return retro.completedEventCount;
    }
    return 0;
  }
  function rememberRetroCursor(index, storageId, nextEvent) {
    if (!index.retro || typeof index.retro !== "object") index.retro = { version: RETRO_VERSION, completedEventCount: 0, bySession: {} };
    if (!index.retro.bySession || typeof index.retro.bySession !== "object") index.retro.bySession = {};
    index.retro.version = RETRO_VERSION;
    index.retro.bySession[storageId] = nextEvent;
    if (storageId === index.canonicalSessionStorageId) index.retro.completedEventCount = nextEvent;
  }
  function resolve(ref, includeClosed) {
    var normalized = topicRef(ref);
    var topic = normalized && load().topics[normalized.topicId];
    if (!topic) return { ok: false, code: "topic_not_found" };
    if (!includeClosed && topic.status !== "open") return { ok: false, code: "topic_closed" };
    return { ok: true, topic: topic, thread: topic, ref: normalized,
      topicRef: normalized, threadRef: { threadId: normalized.topicId } };
  }
  function ensureRetro(session, retroOptions) {
    var storageId = projectIdentity.sessionStorageId(session);
    if (!session || !session.coopHome || !storageId) return { ok: false, code: "canonical_coop_required" };
    var index = load();
    var options = retroOptions || {};
    var expectedStorageId = options.expectedCanonicalStorageId || opts.expectedCanonicalStorageId || null;
    if (expectedStorageId && !sessionMatchesCanonical(session, expectedStorageId)) return { ok: false, code: "canonical_session_mismatch" };
    if (index.canonicalSessionStorageId && !sessionMatchesCanonical(session, index.canonicalSessionStorageId)) {
      return { ok: false, code: "canonical_session_mismatch" };
    }
    var changed = threadLifecycle.migrateState(index, now);
    var retroChanged = topicMigration.prepareRetroUpgrade(index, RETRO_VERSION);
    if (retroChanged) changed = true;
    if (!index.canonicalSessionStorageId) { index.canonicalSessionStorageId = storageId; changed = true; }
    var history = lineage.currentHistoryOf(session);
    var fromEvent = !retroChanged && index.retro.version === RETRO_VERSION
      ? retroCursor(index, storageId, history.length) : 0;
    for (var si = 0; si < SEEDS.length; si++) {
      var seed = SEEDS[si];
      if (!index.topics[seed.id]) {
        index.topics[seed.id] = makeTopic(seed.id, seed.title, seedGroup(seed, options), "automatic", now(), seed.words);
        changed = true;
        fromEvent = 0;
      }
    }
    var extracted = completeTurns(history, fromEvent);
    var refinementTopicIds = {};
    for (var ti = 0; ti < extracted.turns.length; ti++) {
      var turn = extracted.turns[ti];
      turn.sessionStorageId = storageId;
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
          refinementTopicIds[member.topicRef.topicId] = true;
          member.updatedAt = now();
          changed = true;
        }
      }
    }
    if (identityConvergence(index, now)) changed = true;
    if (index.retro.version !== RETRO_VERSION ||
        retroCursor(index, storageId, history.length) !== extracted.nextEvent ||
        (storageId === index.canonicalSessionStorageId && index.retro.completedEventCount !== extracted.nextEvent)) {
      rememberRetroCursor(index, storageId, extracted.nextEvent);
      changed = true;
    }
    if (topicTitleRefinement.ensureRefinement(index, history, Object.keys(refinementTopicIds), now)) changed = true;
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
  function ensureAutomationThread(input) {
    return automationThread.ensure({ load: load, save: save, now: now,
      makeTopic: makeTopic }, input);
  }
  function ensureOwnerThread(input) {
    return ownerThread.ensure({ load: load, save: save, now: now,
      makeTopic: makeTopic }, input);
  }
  function rename(ref, title) {
    var result = resolve(ref, true); var next = cleanTitle(title);
    if (!result.ok) return result;
    if (!next) return { ok: false, code: "invalid_topic_title" };
    result.topic.title = next; result.topic.updatedAt = now();
    topicTitleRefinement.markManualTitle(result.topic, now); save(); return { ok: true };
  }
  function move(ref, group) {
    var result = resolve(ref, true); var next = normalizeGroup(group);
    if (!result.ok) return result;
    if (!next) return { ok: false, code: "invalid_topic_group" };
    result.topic.group = next; result.topic.updatedAt = now(); save(); return { ok: true };
  }

  function merge(targetRef, sourceRefs, options) {
    return threadLifecycle.mergeThreads(migrationSeam, targetRef, sourceRefs, options);
  }

  function split(sourceRef, parts) {
    var source = resolve(sourceRef, false); var list = Array.isArray(parts) ? parts : [];
    if (!source.ok) return source;
    var canonicalStorageId = load().canonicalSessionStorageId;
    var allowed = membershipStorageIds(source.topic, canonicalStorageId);
    var created = [];
    for (var i = 0; i < list.length; i++) {
      var part = list[i] || {};
      var requestedRefs = Array.isArray(part.eventRefs) ? part.eventRefs : [];
      var refs = requestedRefs.map(function (ref) {
        return normalizeEventRef(ref, canonicalStorageId, allowed);
      }).filter(Boolean);
      if (refs.length !== requestedRefs.length) return { ok: false, code: "invalid_event_ref" };
      for (var ri = 0; ri < refs.length; ri++) if (!hasEvent(source.topic, refs[ri])) return { ok: false, code: "event_not_in_source" };
      var result = createSplitTopic({ title: part.title, group: part.group || source.topic.group, topicId: part.topicId });
      if (!result.ok) return result;
      var createdTopic = load().topics[result.topic.topicRef.topicId];
      if (mergeRefs(createdTopic, refs)) { createdTopic.updatedAt = now(); save(); }
      created.push(result.topic.topicRef);
    }
    return { ok: true, topicRefs: created };
  }

  function addEventMembership(ref, refs, session) {
    var result = resolve(ref, false); var storageId = load().canonicalSessionStorageId;
    if (!result.ok) return result;
    var allowed = lineage.allowedStorageIds(session, storageId);
    var valid = (Array.isArray(refs) ? refs : []).map(function (value) {
      return normalizeEventRef(value, storageId, allowed);
    }).filter(Boolean);
    if (valid.length !== (Array.isArray(refs) ? refs.length : 0)) return { ok: false, code: "invalid_event_ref" };
    if (mergeRefs(result.topic, valid)) { result.topic.updatedAt = now(); save(); }
    return { ok: true };
  }

  function linkExecution(ref, execution) {
    var result = resolve(ref, true); var normalized = normalizeExecution(execution, 0);
    if (!result.ok) return result;
    // Closed records may gain links; merged identities may not.
    if (result.topic.status === "merged") return { ok: false, code: "topic_merged" };
    if (!normalized) return { ok: false, code: "invalid_execution_ref" };
    var executionKey = JSON.stringify(normalized);
    var linked = result.topic.relatedExecutions.some(function (candidate) { return JSON.stringify(candidate) === executionKey; });
    if (!linked) result.topic.relatedExecutions.push(normalized);
    if (result.topic.threadState !== threadLifecycle.THREAD_STATES.CLOSED) {
      result.topic.threadState = threadLifecycle.THREAD_STATES.HANDED_OFF;
      result.topic.closeOutcome = null;
      result.topic.threadStateUpdatedAt = now();
    }
    result.topic.updatedAt = now(); save(); return linked ? { ok: true, unchanged: true } : { ok: true };
  }
  function resolveCanonicalEvent(ref, event) {
    var result = resolve(ref, true); var storageId = load().canonicalSessionStorageId;
    if (!result.ok) return result;
    var turnRefs = Array.isArray(result.topic.turnRefs) ? result.topic.turnRefs : [];
    var allowed = membershipStorageIds(result.topic, storageId);
    var canonical = normalizeEventRef(event, storageId, allowed);
    if (!canonical) return { ok: false, code: "invalid_event_ref" };
    if (!hasEvent(result.topic, canonical)) {
      return { ok: false, code: ref && ref.threadId ? "event_not_in_thread" : "event_not_in_topic" };
    }
    var turnRef = null;
    for (var i = 0; i < turnRefs.length; i++) {
      if (!turnRefs[i] || turnRefs[i].sessionStorageId !== canonical.sessionStorageId) continue;
      if (canonical.eventIndex >= turnRefs[i].startEventIndex && canonical.eventIndex <= turnRefs[i].endEventIndex) {
        turnRef = copyRef(turnRefs[i]);
        break;
      }
    }
    return { ok: true, eventRef: canonical, turnRef: turnRef, topicRef: result.ref,
      threadRef: { threadId: result.ref.topicId } };
  }

  function project(options) {
    return topicProjection.projectTopics(load(), options, projectionDeps);
  }

  function validateIngress(session, message, options) {
    var msg = message || {}; var ref = msg.coopThreadRef || msg.threadRef || msg.coopTopicRef || msg.topicRef || null;
    var requestedProject = msg.coopProjectRef || msg.projectRef || null;
    if (!ref && !requestedProject) return { ok: true, topicRef: null, projectRef: null };
    var projectRef = requestedProject ? projectIdentity.normalizeProjectRef(requestedProject) : null;
    if (requestedProject && !projectRef) return { ok: false, code: "invalid_project_ref" };
    if (projectRef && options && typeof options.isProjectAvailable === "function" && !options.isProjectAvailable(projectRef)) return { ok: false, code: "project_target_unavailable" };
    if (!ref) return { ok: true, topicRef: null, projectRef: projectRef };
    var index = load(); var storageId = projectIdentity.sessionStorageId(session);
    if (!session || !session.coopHome || !storageId ||
        !sessionMatchesCanonical(session, index.canonicalSessionStorageId)) {
      return { ok: false, code: "canonical_coop_required" };
    }
    var includeClosed = !!(options && options.includeClosedTopics);
    var resolved = resolve(ref, includeClosed);
    if (!resolved.ok) return resolved;
    if (resolved.topic.group.kind === "project") {
      if (!projectRef || projectRef.projectId !== resolved.topic.group.projectRef.projectId) return { ok: false, code: "topic_project_mismatch" };
    } else if (projectRef) {
      return { ok: false, code: "topic_project_mismatch" };
    }
    if (topicPromotion.recordExplicitRoute(resolved.topic, options, includeClosed)) save();
    return { ok: true, topicRef: resolved.ref, threadRef: resolved.threadRef,
      threadState: resolved.topic.threadState,
      projectRef: resolved.topic.group.kind === "project" ? projectRef : null };
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
    var index = load(); var lifecycleChanged = threadLifecycle.migrateState(index, now);
    if (!session || !session.coopHome || !storageId ||
        !sessionMatchesCanonical(session, index.canonicalSessionStorageId)) {
      return { ok: false, code: "canonical_coop_required" };
    }
    var preferredGroup = projectRef ? normalizeGroup({ projectRef: projectRef }) : null;
    var currentHistory = lineage.currentHistoryOf(session);
    var recent = topicClassification.recentHistoryTopic(index, session.history, topicRef);
    var classified = topicClassification.classifyIngress(index, msg.text || "", preferredGroup, Object.assign({}, classifier(function (ref) {
      return !options || typeof options.isProjectAvailable !== "function" || options.isProjectAvailable(ref);
    }, options && options.projects, recent), { identityEvidence: {
      projectId: projectIdentity.LEAD_PROJECT_ID,
      sessionStorageId: storageId, eventIndex: currentHistory.length,
    } }));
    if (!classified.ok) return classified;
    // An explicit owner request to create an implementation Thread is stronger
    // than ordinary automatic classification. Preserve that deliberate action
    // so its one-turn Thread is eligible for projection before later work adds
    // a second turn or an execution link.
    var explicitlyRouted = !!(options && options.recordExplicitRoute === true &&
      topicPromotion.recordExplicitRoute(classified.topic, { recordExplicitRoute: true }, false));
    if (classified.created || lifecycleChanged || explicitlyRouted) save();
    var inferredProject = classified.topic.group.kind === "project" ? classified.topic.group.projectRef : null;
    return { ok: true, topicRef: copyRef(classified.topic.topicRef),
      threadRef: copyRef(classified.topic.threadRef), threadState: classified.topic.threadState,
      threadTitle: classified.topic.title, projectRef: copyRef(inferredProject),
      created: classified.created,
      classification: topicClassification.lowInformation(msg.text || "")
        ? "conversational" : (classified.created ? "new_topic" : "existing_topic") };
  }

  // Anchor reconciliation, standalone title retrofit, the exactly-once
  // migrations and the durable owner-disposition writer live in
  // coop-topic-index-migrations.js (module-size split); they operate on this
  // instance through the seam below and share its load/save/now/resolve.
  var migrationSeam = { load: load, save: save, now: now, resolve: resolve };

  function ensureThreadLifecycle() { return threadLifecycle.ensureIndex(migrationSeam, now); }
  function setThreadState(ref, state, options) { return threadLifecycle.setThreadState(migrationSeam, ref, state, options); }
  function reassignTurn(source, target, turn, options) { return threadLifecycle.reassignTurn(migrationSeam, source, target, turn, options); }
  function reassignMainIngressRecoveryTurn(source, target, turn, options) {
    return threadLifecycle.reassignMainIngressRecoveryTurn(migrationSeam, source, target, turn, options);
  }
  function undoLastCorrection() { return threadLifecycle.undoLastCorrection(migrationSeam); }
  function undoLastLifecycleAction(ref) { return threadLifecycle.undoLastLifecycleAction(migrationSeam, ref); }
  function recordThreadLifecycleAction(ref, operation, before) {
    return threadLifecycle.recordThreadLifecycleAction(migrationSeam, ref, operation, before);
  }
  function redoCorrection(correctionId) { return threadLifecycle.redoCorrection(migrationSeam, correctionId); }

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

  function reconcileTopicDisposition(ref, decision) {
    return indexMigrations.reconcileTopicDisposition(migrationSeam, ref, decision);
  }

  function ensureTopicConsolidation(session) { return indexMigrations.ensureTopicConsolidation(migrationSeam, session); }
  function proposeTopicClosures(session, options) { return indexMigrations.proposeTopicClosures(migrationSeam, session, options); }
  function confirmTopicClosures(decision, evidence) { return indexMigrations.confirmTopicClosures(migrationSeam, decision, evidence); }

  return {
    load: load,
    save: save,
    identity: store.identity,
    ensureThreadLifecycle: function () { return mutate({ ok: false, code: "persistence_failed" }, ensureThreadLifecycle); },
    ensureRetro: function (session, options) { return mutate({ ok: false, code: "persistence_failed" }, function () { return ensureRetro(session, options); }); },
    reconcileTopicAnchors: function (session) { return mutate({ ok: false, code: "persistence_failed" }, function () { return reconcileTopicAnchors(session); }); },
    retrofitTopicTitles: function (session) { return mutate({ ok: false, code: "persistence_failed" }, function () { return retrofitTopicTitles(session); }); },
    ensureTitleRetrofit: function (session) { return mutate({ ok: false, code: "persistence_failed" }, function () { return ensureTitleRetrofit(session); }); },
    ensureDispositionBackfill: function (session) { return mutate({ ok: false, code: "persistence_failed" }, function () { return ensureDispositionBackfill(session); }); },
    ensureTopicConsolidation: function (session) { return mutate({ ok: false, code: "persistence_failed" }, function () { return ensureTopicConsolidation(session); }); },
    proposeTopicClosures: function (session, options) { return mutate({ ok: false, code: "persistence_failed" }, function () { return proposeTopicClosures(session, options); }); },
    confirmTopicClosures: function (decision, evidence) { return mutate({ ok: false, code: "persistence_failed" }, function () { return confirmTopicClosures(decision, evidence); }); },
    applyTopicDisposition: function (ref, decision) { return mutate({ ok: false, code: "persistence_failed" }, function () { return applyTopicDisposition(ref, decision); }); },
    reconcileTopicDisposition: function (ref, decision) { return mutate({ ok: false, code: "persistence_failed" }, function () { return reconcileTopicDisposition(ref, decision); }); },
    rename: function (ref, title) { return mutate({ ok: false, code: "persistence_failed" }, function () { return rename(ref, title); }); },
    move: function (ref, group) { return mutate({ ok: false, code: "persistence_failed" }, function () { return move(ref, group); }); },
    merge: function (target, sources, options) { return mutate({ ok: false, code: "persistence_failed" }, function () { return merge(target, sources, options); }); },
    reassignTurn: function (source, target, turn, options) { return mutate({ ok: false, code: "persistence_failed" }, function () { return reassignTurn(source, target, turn, options); }); },
    reassignMainIngressRecoveryTurn: function (source, target, turn, options) {
      return mutate({ ok: false, code: "persistence_failed" }, function () {
        return reassignMainIngressRecoveryTurn(source, target, turn, options);
      });
    },
    undoLastCorrection: function () { return mutate({ ok: false, code: "persistence_failed" }, undoLastCorrection); },
    undoLastLifecycleAction: function (ref) { return mutate({ ok: false, code: "persistence_failed" }, function () { return undoLastLifecycleAction(ref); }); },
    recordThreadLifecycleAction: function (ref, operation, before) {
      return mutate({ ok: false, code: "persistence_failed" }, function () {
        return recordThreadLifecycleAction(ref, operation, before);
      });
    },
    redoCorrection: function (correctionId) { return mutate({ ok: false, code: "persistence_failed" }, function () { return redoCorrection(correctionId); }); },
    lastCorrection: function () { return threadLifecycle.lastCorrection(migrationSeam); },
    // Exact production recoveries sometimes need to mint a new canonical
    // Thread for an owner turn that was never assigned to a source Thread.
    // The same validation and atomic store boundary as a user-driven split
    // applies; only the missing source relationship differs.
    createTopic: function (input) { return mutate({ ok: false, code: "persistence_failed" }, function () {
      return createSplitTopic(input);
    }); },
    ensureAutomationThread: function (input) {
      return mutate({ ok: false, code: "persistence_failed" }, function () {
        return ensureAutomationThread(input);
      });
    },
    ensureOwnerThread: function (input) {
      return mutate({ ok: false, code: "persistence_failed" }, function () {
        return ensureOwnerThread(input);
      });
    },
    setThreadState: function (ref, state, options) { return mutate({ ok: false, code: "persistence_failed" }, function () { return setThreadState(ref, state, options); }); },
    split: function (source, parts) { return mutate({ ok: false, code: "persistence_failed" }, function () { return split(source, parts); }); },
    close: function (ref) { return mutate({ ok: false, code: "persistence_failed" }, function () {
      return setThreadState(ref, threadLifecycle.THREAD_STATES.CLOSED, { closeOutcome: threadLifecycle.CLOSE_OUTCOMES.IMPLEMENTED_RESOLVED });
    }); },
    reopen: function (ref) { return mutate({ ok: false, code: "persistence_failed" }, function () {
      return setThreadState(ref, threadLifecycle.THREAD_STATES.EXPLORING);
    }); },
    addEventMembership: function (ref, refs, session) {
      return mutate({ ok: false, code: "persistence_failed" }, function () { return addEventMembership(ref, refs, session); });
    },
    linkExecution: function (ref, execution) { return mutate({ ok: false, code: "persistence_failed" }, function () { return linkExecution(ref, execution); }); },
    resolveCanonicalEvent: resolveCanonicalEvent,
    project: project,
    validateIngress: function (session, message, options) { return mutate({ ok: false, code: "persistence_failed" }, function () { return validateIngress(session, message, options); }); },
    classifyCanonicalIngress: function (session, message, options) { return mutate({ ok: false, code: "persistence_failed" }, function () { return classifyCanonicalIngress(session, message, options); }); },
    resolve: resolve,
    file: file,
  };
}

var defaultIndex = null;
function getDefaultTopicIndex() {
  if (!defaultIndex) defaultIndex = createTopicIndex();
  return defaultIndex;
}

module.exports = { createTopicIndex: createTopicIndex, getDefaultTopicIndex: getDefaultTopicIndex, topicRef: topicRef, canonicalEventRef: canonicalEventRef, normalizeGroup: normalizeGroup, CLAY_PROJECT_ID: CLAY_PROJECT_ID, SEEDS: SEEDS };
