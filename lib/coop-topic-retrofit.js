// Bounded, idempotent title retrofit for topics minted before the classifier
// fixes (contraction collapse, fuller stopword list, low-information routing).
//
// This is deliberately NOT a RETRO_VERSION bump. That clears every automatic
// topic's membership and replays the ENTIRE canonical history through the
// classifier from event 0, which can reshuffle which topic any given turn
// lands in project-wide -- a much larger blast radius than a title fix needs,
// and it was judged too risky to run inside a single segment without owner
// sign-off on that specific trade-off. This module only ever touches topics
// already sitting in the index, using only their already-proven anchors
// (coop-topic-anchors), and only ever rewrites .title/.keywords -- never
// .topicRef, so every existing link (a task's coopTopicRef, a bookmark, a
// deep link) keeps working -- or reroutes an already-open fragment's own
// turnRefs into the uncategorised catch-all, exactly like a live low-
// information turn would route today.
//
// Fail-closed rules, in order, per automatic+open topic:
//   1. No proven anchor -> already unprojectable (coop-topic-anchors handles
//      that independently); left untouched here, just recorded.
//   2. Title no longer matches its own creation fingerprint (a rename
//      happened since auto-creation, by the owner or anything else) -> left
//      untouched. Explicit titles are never overwritten by a guess.
//   3. Combined proven-turn text is low-information -> merged into the
//      uncategorised catch-all (membership preserved, no fragment row).
//   4. Otherwise -> retitled from the same proven text through the corrected
//      classifier.
//
// Nothing here mutates canonical session history. It reads history read-only
// and writes topic-index metadata only. Idempotent and restart-safe: a topic
// already retitled or merged under the current schema version is never
// re-touched; a topic left alone is re-evaluated only if its proven-anchor
// count has since changed (e.g. a later anchor-rule upgrade proves more).

var topicAnchors = require("./coop-topic-anchors");
var classification = require("./coop-topic-classification");

var TITLE_RETROFIT_SCHEMA_VERSION = 2;
var UNCATEGORISED_ID = "uncategorised-conversations";
var TERMINAL_ACTIONS = { retitled: true, merged_uncategorised: true };

// Machine provenance for a title. Either the title still matches its own
// creation fingerprint (never renamed since auto-creation) or a PRIOR schema
// version of this retrofit wrote it (audit action "retitled") -- v1's
// bag-of-words output broke the fingerprint, but its own audit proves the
// title came from this machinery, never from the owner. Owner renames carry
// neither marker, so they remain untouchable under every version.
function machineTitled(topic) {
  if (classification.isUnmodifiedAutomaticTitle(topic)) return true;
  var audit = topic && topic.titleRetrofitAudit;
  return !!(audit && audit.action === "retitled" && audit.schemaVersion < TITLE_RETROFIT_SCHEMA_VERSION);
}

function turnText(history, ref) {
  // A proven anchor may resolve via the canonical offset 0 or the legacy +1
  // fallback (see coop-topic-anchors) -- the ref itself is never re-pointed,
  // so ref.startEventIndex alone is only reliably the owner turn start under
  // offset 0. Re-deriving which offset actually proved it and reading the
  // record there is what avoids silently sourcing title text from a "done"
  // boundary record instead of the real owner message.
  var verdict = topicAnchors.proveAnchor(history, ref);
  if (!verdict.proven) return "";
  var index = topicAnchors.candidateIndex(ref, verdict.offset, Array.isArray(history) ? history.length : 0);
  var record = index === null ? null : history[index];
  return record ? String(record.text || "") : "";
}

function combinedProvenText(topic, history) {
  var refs = topicAnchors.provenTurnRefs(topic, history);
  var parts = [];
  for (var i = 0; i < refs.length; i++) {
    var text = turnText(history, refs[i]);
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

function turnKey(ref) {
  return String(ref && ref.sessionStorageId || "") + ":" + String(ref && ref.startEventIndex) + ":" + String(ref && ref.endEventIndex);
}

function eventKey(ref) {
  return String(ref && ref.sessionStorageId || "") + ":" + String(ref && ref.eventIndex);
}

// Moves a fragment's own membership into the uncategorised catch-all and
// marks the fragment merged, mirroring the existing manual merge() convention
// (status: "merged", mergedInto) so downstream projection code has exactly
// one meaning for those fields regardless of which path produced them.
function mergeIntoUncategorised(topic, target, now) {
  var targetTurnRefs = Array.isArray(target.turnRefs) ? target.turnRefs : (target.turnRefs = []);
  var seenTurns = {};
  for (var i = 0; i < targetTurnRefs.length; i++) seenTurns[turnKey(targetTurnRefs[i])] = true;
  var sourceTurnRefs = Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
  var movedTurns = 0;
  for (var ti = 0; ti < sourceTurnRefs.length; ti++) {
    var key = turnKey(sourceTurnRefs[ti]);
    if (seenTurns[key]) continue;
    seenTurns[key] = true;
    targetTurnRefs.push(sourceTurnRefs[ti]);
    movedTurns += 1;
  }
  targetTurnRefs.sort(function (a, b) { return a.startEventIndex - b.startEventIndex; });

  var targetEventRefs = Array.isArray(target.eventRefs) ? target.eventRefs : (target.eventRefs = []);
  var seenEvents = {};
  for (var ei = 0; ei < targetEventRefs.length; ei++) seenEvents[eventKey(targetEventRefs[ei])] = true;
  var sourceEventRefs = Array.isArray(topic.eventRefs) ? topic.eventRefs : [];
  for (var evi = 0; evi < sourceEventRefs.length; evi++) {
    var ekey = eventKey(sourceEventRefs[evi]);
    if (seenEvents[ekey]) continue;
    seenEvents[ekey] = true;
    targetEventRefs.push(sourceEventRefs[evi]);
  }

  if (movedTurns > 0 || sourceEventRefs.length > 0) target.updatedAt = now();
  topic.status = "merged";
  topic.mergedInto = { topicId: target.topicRef.topicId };
  topic.updatedAt = now();
  return movedTurns;
}

// Runs the retrofit over every automatic, open topic in the index. Returns a
// full before/after inventory: one entry per topic touched or explicitly
// left alone, never silent.
function retrofitTitles(index, options) {
  var opts = options || {};
  var historyFor = typeof opts.historyFor === "function" ? opts.historyFor : function () { return null; };
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var topics = (index && index.topics) || {};
  var ids = Object.keys(topics).sort();
  var uncategorised = topics[UNCATEGORISED_ID];

  var report = {
    schemaVersion: TITLE_RETROFIT_SCHEMA_VERSION,
    checked: 0, retitled: 0, mergedToUncategorised: 0,
    skippedOwnerModified: 0, skippedNoProvenAnchor: 0, unchanged: 0,
    entries: [],
  };

  // Titles already present in the index (any status), lowercased. New titles
  // must not collide with an existing row or with each other -- two identical
  // sidebar labels are indistinguishable to the owner. Deterministic because
  // ids are processed in sorted order.
  var usedTitles = {};
  for (var u = 0; u < ids.length; u++) {
    var existingTitle = topics[ids[u]] && topics[ids[u]].title;
    if (existingTitle) usedTitles[String(existingTitle).toLowerCase()] = ids[u];
  }

  function uniqueTitle(base, topicId) {
    var candidate = base;
    var n = 2;
    while (usedTitles[candidate.toLowerCase()] && usedTitles[candidate.toLowerCase()] !== topicId) {
      candidate = base + " (" + n + ")";
      n += 1;
    }
    return candidate;
  }

  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var topic = topics[id];
    if (!topic || topic.source !== "automatic" || topic.status !== "open") continue;
    report.checked += 1;

    var existing = topic.titleRetrofitAudit;
    // Terminal actions are sticky forever: once a title is fixed or a
    // fragment is merged, later conversation added to the same topic must
    // never make its title (or membership routing) flip again.
    if (existing && existing.schemaVersion === TITLE_RETROFIT_SCHEMA_VERSION && TERMINAL_ACTIONS[existing.action]) {
      report.unchanged += 1;
      continue;
    }

    var history = historyFor(topic);
    var provenRefs = topicAnchors.provenTurnRefs(topic, history);
    var provenCount = provenRefs.length;

    if (existing && existing.schemaVersion === TITLE_RETROFIT_SCHEMA_VERSION && existing.provenCount === provenCount) {
      report.unchanged += 1;
      continue;
    }

    if (provenCount === 0) {
      topic.titleRetrofitAudit = { schemaVersion: TITLE_RETROFIT_SCHEMA_VERSION, checkedAt: now(), provenCount: 0, action: "skipped_no_proven_anchor" };
      report.skippedNoProvenAnchor += 1;
      report.entries.push({ topicId: id, action: "skipped_no_proven_anchor", title: topic.title });
      continue;
    }

    if (!machineTitled(topic)) {
      topic.titleRetrofitAudit = { schemaVersion: TITLE_RETROFIT_SCHEMA_VERSION, checkedAt: now(), provenCount: provenCount, action: "skipped_owner_modified" };
      report.skippedOwnerModified += 1;
      report.entries.push({ topicId: id, action: "skipped_owner_modified", title: topic.title });
      continue;
    }

    var text = combinedProvenText(topic, history);
    var canRouteToUncategorised = uncategorised && uncategorised.status === "open" && uncategorised.topicRef.topicId !== id;
    if (classification.lowInformation(text) && canRouteToUncategorised) {
      var beforeTitle = topic.title;
      var moved = mergeIntoUncategorised(topic, uncategorised, now);
      topic.titleRetrofitAudit = { schemaVersion: TITLE_RETROFIT_SCHEMA_VERSION, checkedAt: now(), provenCount: provenCount, action: "merged_uncategorised" };
      report.mergedToUncategorised += 1;
      report.entries.push({ topicId: id, action: "merged_uncategorised", from: beforeTitle, turnRefsMoved: moved });
      continue;
    }

    var metadata = classification.derivedMetadata(text);
    var newTitle = metadata.title ? uniqueTitle(metadata.title, id) : "";
    if (!newTitle || newTitle === topic.title) {
      topic.titleRetrofitAudit = { schemaVersion: TITLE_RETROFIT_SCHEMA_VERSION, checkedAt: now(), provenCount: provenCount, action: "unchanged" };
      report.unchanged += 1;
      report.entries.push({ topicId: id, action: "unchanged", title: topic.title });
      continue;
    }

    var before = topic.title;
    delete usedTitles[String(before).toLowerCase()];
    usedTitles[newTitle.toLowerCase()] = id;
    topic.title = newTitle;
    topic.keywords = metadata.keywords;
    topic.updatedAt = now();
    topic.titleRetrofitAudit = { schemaVersion: TITLE_RETROFIT_SCHEMA_VERSION, checkedAt: now(), provenCount: provenCount, action: "retitled" };
    report.retitled += 1;
    report.entries.push({ topicId: id, action: "retitled", from: before, to: newTitle });
  }

  return report;
}

module.exports = {
  TITLE_RETROFIT_SCHEMA_VERSION: TITLE_RETROFIT_SCHEMA_VERSION,
  retrofitTitles: retrofitTitles,
};
