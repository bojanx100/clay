// Progressive Thread titles derived only from proven owner-authored turns.
//
// The one-time retrofit repairs historical titles. This module handles the
// forward-looking contract: a fresh automatic Thread may start with a rough
// name, then adopt a clearer purpose once multiple related owner turns support
// it. It never mutates Thread identity, lifecycle, grouping, membership, or
// execution links.

var crypto = require("crypto");
var topicAnchors = require("./coop-topic-anchors");
var classification = require("./coop-topic-classification");
var relevance = require("./coop-topic-relevance");
var topicTitle = require("./coop-topic-title");

var REFINEMENT_VERSION = 1;
var MAX_CLAUSES_PER_TURN = 8;
var MAX_EVIDENCE_TURNS = 32;
var MAX_TITLE_WORDS = 12;
var MAX_TITLE_CHARS = 96;
var MIN_SCORE_GAIN = 4;

function normalizeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
    .replace(/^[\s,;:.!?]+|[\s,;:.!?]+$/g, "");
}

// A refined title is a complete owner phrase, never a clipped prefix. Long
// clauses remain evidence for scoring and classification, but are not copied
// into the sidebar with an ellipsis pretending to be a settled purpose.
function completeClauseTitle(value) {
  var title = normalizeTitle(value);
  if (!title) return "";
  title = title.replace(/^(?:ok(?:ay)?|so|well|actually|basically|anyway)\s*[,;:-]?\s+/i, "");
  title = title.replace(/^(?:i|we)\s+(?:need|want|think|believe)\s+(?:to\s+)?/i, "");
  title = title.replace(/^(?:can|could|would)\s+you\s+/i, "");
  title = title.replace(/^please\s+/i, "");
  title = normalizeTitle(title);
  var words = title ? title.split(" ") : [];
  if (words.length < 2 || words.length > MAX_TITLE_WORDS || title.length > MAX_TITLE_CHARS) return "";
  if (classification.namesNewSubject(title) !== true) return "";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function candidateKey(value) {
  return classification.derivedMetadata(value).keywords.join("|") + "|" +
    String(value || "").toLowerCase();
}

function candidatesForText(text, turnIndex) {
  var clauses = topicTitle.splitClauses(text).slice(0, MAX_CLAUSES_PER_TURN);
  var candidates = [];
  for (var i = 0; i < clauses.length; i++) {
    var title = completeClauseTitle(clauses[i]);
    if (!title) continue;
    var words = classification.matchableKeywords(classification.keywords(clauses[i]));
    if (words.length < 2) continue;
    candidates.push({
      key: candidateKey(title),
      title: title,
      words: words,
      turnIndex: turnIndex,
      clauseIndex: i,
      supportTurns: 0,
      supportWords: 0,
      score: 0,
    });
  }
  return candidates;
}

function sharedWordCount(left, right) {
  var seen = {};
  var count = 0;
  for (var i = 0; i < left.length; i++) seen[left[i]] = true;
  for (var j = 0; j < right.length; j++) if (seen[right[j]]) count++;
  return count;
}

function scoreCandidates(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var supportedTurns = {};
    var shared = 0;
    for (var j = 0; j < candidates.length; j++) {
      if (i === j || candidates[i].turnIndex === candidates[j].turnIndex) continue;
      var overlap = sharedWordCount(candidates[i].words, candidates[j].words);
      if (!overlap) continue;
      supportedTurns[candidates[j].turnIndex] = true;
      shared += overlap;
    }
    candidates[i].supportTurns = Object.keys(supportedTurns).length;
    candidates[i].supportWords = shared;
    candidates[i].score = candidates[i].supportTurns * 12 +
      Math.min(candidates[i].supportWords, 8) * 3 +
      Math.min(candidates[i].words.length, 6) * 2 +
      (candidates[i].title.split(" ").length <= 8 ? 2 : 0);
  }
  return candidates;
}

function betterCandidate(left, right) {
  if (!right) return true;
  if (left.score !== right.score) return left.score > right.score;
  if (left.supportTurns !== right.supportTurns) return left.supportTurns > right.supportTurns;
  if (left.turnIndex !== right.turnIndex) return left.turnIndex < right.turnIndex;
  if (left.clauseIndex !== right.clauseIndex) return left.clauseIndex < right.clauseIndex;
  return left.title.localeCompare(right.title) < 0;
}

function bestCandidate(texts) {
  var candidates = [];
  for (var i = 0; i < texts.length; i++) {
    candidates = candidates.concat(candidatesForText(texts[i], i));
  }
  scoreCandidates(candidates);
  var best = null;
  for (var ci = 0; ci < candidates.length; ci++) {
    if (betterCandidate(candidates[ci], best)) best = candidates[ci];
  }
  return { best: best, candidates: candidates };
}

function ownerTexts(topic, history) {
  var items = Array.isArray(history) ? history : [];
  var refs = topicAnchors.provenTurnRefs(topic, items);
  var texts = [];
  for (var i = 0; i < refs.length; i++) {
    var verdict = topicAnchors.proveAnchor(items, refs[i]);
    if (!verdict.proven) continue;
    var index = topicAnchors.candidateIndex(refs[i], verdict.offset, items.length);
    var record = index === null ? null : items[index];
    if (!record || record.type !== "user_message" || relevance.isInternalHistoryItem(record) ||
        !relevance.hasOwnerProvenance(record)) continue;
    var text = String(record.text || "").trim();
    if (text) texts.push(text);
  }
  return texts;
}

function evidenceDigest(texts) {
  return crypto.createHash("sha256").update(texts.map(function (text) {
    return String(text.length) + ":" + text;
  }).join("\n")).digest("hex");
}

function boundedEvidenceTexts(texts) {
  if (texts.length <= MAX_EVIDENCE_TURNS) return texts;
  return texts.slice(0, 8).concat(texts.slice(texts.length - 24));
}

function machineManaged(topic) {
  if (!topic || topic.titleManuallySet === true) return false;
  var refinement = topic.titleRefinement;
  if (refinement && refinement.manual === true) return false;
  if (refinement && refinement.managed === true) return true;
  if (classification.isUnmodifiedAutomaticTitle(topic)) return true;
  var audit = topic.titleRetrofitAudit;
  return !!(audit && audit.action === "retitled");
}

function currentCandidateScore(topic, candidates) {
  var current = String(topic && topic.title || "").toLowerCase();
  var best = 0;
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].title.toLowerCase() === current) best = Math.max(best, candidates[i].score);
  }
  return best;
}

function refineTopic(topic, history, now) {
  var id = topic && topic.topicRef && topic.topicRef.topicId;
  if (!topic || topic.source !== "automatic" || topic.status !== "open" ||
      typeof id !== "string" || !/^auto-[a-f0-9]{24}$/.test(id) || !machineManaged(topic)) {
    return { changed: false };
  }
  var texts = ownerTexts(topic, history);
  if (texts.length < 2) return { changed: false };
  var ranked = bestCandidate(boundedEvidenceTexts(texts));
  var best = ranked.best;
  if (!best || best.supportTurns < 1 || best.title === topic.title) return { changed: false };
  var refinement = topic.titleRefinement || {};
  var previousScore = refinement.managed === true && Number.isFinite(refinement.score)
    ? refinement.score : currentCandidateScore(topic, ranked.candidates);
  if (best.score < previousScore + MIN_SCORE_GAIN) return { changed: false };

  var before = topic.title;
  topic.title = best.title;
  topic.updatedAt = now();
  topic.titleRefinement = {
    version: REFINEMENT_VERSION,
    managed: true,
    manual: false,
    score: best.score,
    supportTurns: best.supportTurns,
    evidenceCount: texts.length,
    evidenceDigest: evidenceDigest(texts),
    selectedKey: best.key,
    updatedAt: topic.updatedAt,
  };
  return { changed: true, topicId: id, from: before, to: best.title };
}

function refineAutomaticTitles(index, history, now, topicIds) {
  var topics = index && index.topics || {};
  var ids = Array.isArray(topicIds) ? topicIds.slice().sort() : Object.keys(topics).sort();
  var clock = typeof now === "function" ? now : Date.now;
  var report = { changed: false, retitled: 0, entries: [] };
  for (var i = 0; i < ids.length; i++) {
    var result = refineTopic(topics[ids[i]], history, clock);
    if (!result.changed) continue;
    report.changed = true;
    report.retitled++;
    report.entries.push(result);
  }
  return report;
}

function ensureRefinement(index, history, touchedTopicIds, now) {
  var due = index && index.titleRefinementVersion !== REFINEMENT_VERSION;
  var touched = Array.isArray(touchedTopicIds) ? touchedTopicIds : [];
  if (!due && !touched.length) return false;
  var changed = refineAutomaticTitles(index, history, now, due ? null : touched).changed;
  index.titleRefinementVersion = REFINEMENT_VERSION;
  return changed || due;
}

function markManualTitle(topic, now) {
  if (!topic) return;
  topic.titleManuallySet = true;
  topic.titleRefinement = {
    version: REFINEMENT_VERSION,
    managed: false,
    manual: true,
    updatedAt: (typeof now === "function" ? now : Date.now)(),
  };
}

module.exports = {
  REFINEMENT_VERSION: REFINEMENT_VERSION,
  completeClauseTitle: completeClauseTitle,
  evidenceDigest: evidenceDigest,
  ensureRefinement: ensureRefinement,
  refineAutomaticTitles: refineAutomaticTitles,
  refineTopic: refineTopic,
  markManualTitle: markManualTitle,
};
