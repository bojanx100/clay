// Retro consolidation: fold the single-turn automatic topics the old minting
// rule split off back into the conversation they belong to.
//
// The live rule change (coop-topic-classification.classifyIngress) stops NEW
// sprawl, but the index already carried the damage: an audit of 191 owner
// ingresses found 53 unanswered requests spread over 33 distinct topics, most
// holding exactly one turn. The owner's complaint -- "we can't have 7 topics for
// one session", "Topics are not good enough, it's not grouped meaningfull
// enough" -- is about those existing rows, so the rule change alone does not
// answer it.
//
// This is deliberately shaped like the existing exactly-once migrations
// (coop-topic-index-migrations.js): index-only, deterministic, per-topic
// audited, index-stamped, and safe to call again after a restart.
//
// What it may touch, and nothing else. A candidate must be ALL of:
//   * source "automatic" AND carrying an auto-minted id (auto-<24 hex>), which
//     is what separates a minted fragment from a curated seed -- seeds share
//     source "automatic" but keep stable readable ids;
//   * status "open" -- a closed topic is a resolution the owner recorded and a
//     merged one is gone for good; neither is reopened or re-merged here;
//   * still wearing the title auto-creation derived
//     (classification.isUnmodifiedAutomaticTitle), so an owner rename is never
//     silently undone;
//   * holding at most one turn span -- a passing remark, not a thread;
//   * carrying no linked execution, no explicit owner route, and no recorded
//     owner disposition -- each of those is the owner having treated the topic
//     as real, which is exactly the promotion evidence coop-topic-promotion
//     already recognises.
// Manual and split topics are owner acts and are never candidates at all.
//
// Determinism and idempotency come from one rule: the candidate set and the host
// set are computed ONCE, from the state as found, and a candidate can never be a
// host. So merges cannot chain, the outcome cannot depend on visit order, and a
// second pass finds every former candidate already merged.

var classification = require("./coop-topic-classification");
var topicRetrofit = require("./coop-topic-retrofit");

var CONSOLIDATION_SCHEMA_VERSION = 1;
var AUTOMATIC_ID_RE = /^auto-[a-f0-9]{24}$/;
var UNCATEGORISED_ID = "uncategorised-conversations";

// A passing remark is one turn. Two is a thread the owner came back to, which is
// the same line coop-topic-promotion draws for showing a row at all.
var MAX_CANDIDATE_TURNS = 1;
// A host has to be an actual conversation, not another fragment.
var MIN_HOST_TURNS = 2;
// One shared content word is the weakest evidence live classification accepts
// for reuse (WEAK_OVERLAP), and this pass groups by exactly that signal so a
// retro merge lands where a live turn would land today.
var MIN_HOST_OVERLAP = classification.WEAK_OVERLAP;

function turnCount(topic) {
  return classification.turnCount(topic);
}

function isAutomaticallyMinted(topic) {
  var id = topic && topic.topicRef && topic.topicRef.topicId;
  return !!(topic && topic.source === "automatic" && typeof id === "string" && AUTOMATIC_ID_RE.test(id));
}

// Evidence the owner has treated this topic as a real thread. Mirrors
// coop-topic-promotion's notion of promotion evidence: anything that would earn
// a sidebar row must also protect the topic from being folded away.
function ownerTreatedAsReal(topic) {
  if (!topic) return false;
  if (topic.explicitlyRouted === true) return true;
  if (Array.isArray(topic.relatedExecutions) && topic.relatedExecutions.length) return true;
  if (topic.ownerDisposition && typeof topic.ownerDisposition === "object" && topic.ownerDisposition.status) return true;
  return false;
}

function isCandidate(topic) {
  if (!isAutomaticallyMinted(topic)) return false;
  if (topic.status !== "open") return false;
  if (topic.topicRef.topicId === UNCATEGORISED_ID) return false;
  if (!classification.isUnmodifiedAutomaticTitle(topic)) return false;
  if (turnCount(topic) > MAX_CANDIDATE_TURNS) return false;
  if (ownerTreatedAsReal(topic)) return false;
  return true;
}

// A host is any open, reusable conversation with real membership -- automatic,
// manual or split alike. Manual and split topics deliberately CAN receive
// membership: the owner made them on purpose, so a stray remark belongs there
// just as much as in an established automatic thread.
function isHost(topic) {
  if (!classification.reusableTopic(topic)) return false;
  if (topic.status !== "open") return false;
  if (topic.topicRef.topicId === UNCATEGORISED_ID) return false;
  return turnCount(topic) >= MIN_HOST_TURNS;
}

// The conversation this fragment belongs to, or null. Ranked by keyword overlap,
// then by how established the conversation is, then by lowest topic id -- the
// same clock-free ordering coop-topic-classification.bestExisting uses, so the
// retro answer and the live answer agree.
function bestHost(topic, hosts) {
  var words = classification.matchableKeywords(classification.topicKeywords(topic));
  if (!words.length) return null;
  var best = null;
  var bestScore = 0;
  var bestTurns = 0;
  for (var i = 0; i < hosts.length; i++) {
    var host = hosts[i];
    if (host.topicRef.topicId === topic.topicRef.topicId) continue;
    if (!classification.groupMatches(host, topic.group)) continue;
    var score = classification.overlap(words, classification.matchableKeywords(classification.topicKeywords(host)));
    if (score < MIN_HOST_OVERLAP) continue;
    var turns = turnCount(host);
    if (best && score <= bestScore && (score < bestScore || turns <= bestTurns)) continue;
    best = host;
    bestScore = score;
    bestTurns = turns;
  }
  return best ? { host: best, score: bestScore } : null;
}

function openTopicCount(index) {
  var topics = (index && index.topics) || {};
  var ids = Object.keys(topics);
  var count = 0;
  for (var i = 0; i < ids.length; i++) if (topics[ids[i]] && topics[ids[i]].status === "open") count += 1;
  return count;
}

// Folds every eligible fragment into its conversation. Returns a full
// before/after inventory: one entry per fragment merged or explicitly kept,
// never silent about what it decided.
function consolidateTopics(index, options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var topics = (index && index.topics) || {};
  var ids = Object.keys(topics).sort();

  var report = {
    schemaVersion: CONSOLIDATION_SCHEMA_VERSION,
    checked: 0, merged: 0, keptNoHost: 0, alreadyDone: 0,
    openBefore: openTopicCount(index), openAfter: 0, entries: [],
  };

  // One snapshot, taken before anything moves. This is what makes the pass
  // order-independent: a fragment can never become a host mid-pass, and a host
  // can never become a fragment, so no merge can chain into another.
  var candidateIds = [];
  var hosts = [];
  for (var i = 0; i < ids.length; i++) {
    var topic = topics[ids[i]];
    if (!topic || typeof topic !== "object" || !topic.topicRef) continue;
    if (isCandidate(topic)) candidateIds.push(ids[i]);
    else if (isHost(topic)) hosts.push(topic);
  }

  for (var c = 0; c < candidateIds.length; c++) {
    var fragment = topics[candidateIds[c]];
    report.checked += 1;
    var audit = fragment.consolidationAudit;
    if (audit && audit.schemaVersion === CONSOLIDATION_SCHEMA_VERSION) {
      report.alreadyDone += 1;
      continue;
    }
    var match = bestHost(fragment, hosts);
    if (!match) {
      // No conversation to belong to. Left exactly as found -- routing a lone
      // subject into the catch-all is the title retrofit's job, on proven
      // anchors, not a guess made from keywords here.
      fragment.consolidationAudit = {
        schemaVersion: CONSOLIDATION_SCHEMA_VERSION, checkedAt: now(), action: "kept_no_host",
      };
      report.keptNoHost += 1;
      report.entries.push({ topicId: candidateIds[c], action: "kept_no_host", title: fragment.title });
      continue;
    }
    var movedTurns = topicRetrofit.mergeMembershipInto(fragment, match.host, now);
    fragment.consolidationAudit = {
      schemaVersion: CONSOLIDATION_SCHEMA_VERSION, checkedAt: now(), action: "merged_into",
      mergedInto: match.host.topicRef.topicId, overlap: match.score,
    };
    report.merged += 1;
    report.entries.push({
      topicId: candidateIds[c], action: "merged_into", from: fragment.title,
      into: match.host.topicRef.topicId, intoTitle: match.host.title,
      overlap: match.score, turnRefsMoved: movedTurns,
    });
  }

  report.openAfter = openTopicCount(index);
  return report;
}

module.exports = {
  CONSOLIDATION_SCHEMA_VERSION: CONSOLIDATION_SCHEMA_VERSION,
  MAX_CANDIDATE_TURNS: MAX_CANDIDATE_TURNS,
  MIN_HOST_TURNS: MIN_HOST_TURNS,
  consolidateTopics: consolidateTopics,
  openTopicCount: openTopicCount,
  isCandidate: isCandidate,
  isHost: isHost,
};
