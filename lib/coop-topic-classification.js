// Deterministic, body-free classification for canonical Coop topic lenses.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var topicRelevance = require("./coop-topic-relevance");
var correctionEvidence = require("./coop-topic-correction-evidence");

var topicTitle = require("./coop-topic-title");

// Reuse thresholds, strongest first. STRONG is unconditional topical evidence:
// two content words shared with a stored topic. WEAK is a single shared content
// word, which is enough to reuse but NOT enough to override a group boundary --
// see classifyIngress.
var STRONG_OVERLAP = 2;
var WEAK_OVERLAP = 1;

// Derivation from the owner's own words lives in coop-topic-title.js (module-size
// split). Bound locally so the routing code below reads exactly as it did, and
// re-exported unchanged at the bottom so every existing caller keeps working.
var normalizeText = topicTitle.normalizeText;
var keywords = topicTitle.keywords;
var readableTitle = topicTitle.readableTitle;
var diagnosticTitle = topicTitle.diagnosticTitle;
var namesNewSubject = topicTitle.namesNewSubject;
var matchableKeywords = topicTitle.matchableKeywords;
var derivedMetadata = topicTitle.derivedMetadata;
var lowInformation = topicTitle.lowInformation;

function groupKey(group) {
  return group && group.kind === "project" ? "project:" + group.projectRef.projectId : group && group.kind || "uncategorised";
}

function automaticTopicId(text, group) {
  var metadata = derivedMetadata(text);
  var digest = crypto.createHash("sha256").update(groupKey(group) + "\n" + normalizeText(metadata.title)).digest("hex");
  return "auto-" + digest.slice(0, 24);
}

function addUnique(topics, topic) {
  if (!topic) return;
  for (var i = 0; i < topics.length; i++) {
    if (topics[i].topicRef.topicId === topic.topicRef.topicId) return;
  }
  topics.push(topic);
}

function projectAllowed(topic, canAccessProject) {
  return topic.group.kind !== "project" || !canAccessProject || canAccessProject(topic.group.projectRef);
}

function groupMatches(topic, preferredGroup) {
  if (!preferredGroup) return true;
  if (preferredGroup.kind !== "project") return topic.group.kind === preferredGroup.kind;
  return topic.group.kind === "project" && topic.group.projectRef.projectId === preferredGroup.projectRef.projectId;
}

// Closed and merged topics are sealed against new membership. A closed topic is
// a resolution the owner recorded; a merged one is gone for good. Neither may
// gain a turn, and neither auto-reopens -- reopening stays an explicit owner
// act. This is the single predicate every routing path below consults, so
// explicit, seed, catch-all and automatic routing cannot drift apart.
function openTopic(topic) {
  return !!(topic && topic.status === "open");
}

function usable(topic, preferredGroup, canAccessProject) {
  return !!(openTopic(topic) && groupMatches(topic, preferredGroup) && projectAllowed(topic, canAccessProject));
}

function reusableTopic(topic) {
  return !!(topic && topic.topicRef && topic.topicRef.topicId !== "uncategorised-conversations" &&
    (topic.source === "automatic" || topic.source === "manual" || topic.source === "split"));
}

function topicKeywords(topic) {
  // Stored keywords are the matching signal. Title words are only a fallback
  // for manual/legacy topics that never stored keywords -- readable excerpt
  // titles carry verbatim prose that must not broaden matching.
  var values = Array.isArray(topic && topic.keywords) ? topic.keywords.slice() : [];
  if (values.length) return values;
  return keywords(topic && topic.title);
}

function overlap(left, right) {
  var values = {};
  for (var i = 0; i < left.length; i++) values[left[i]] = true;
  var count = 0;
  for (var j = 0; j < right.length; j++) if (values[right[j]]) count++;
  return count;
}

function mostRecentTopic(index, storageId, beforeEvent) {
  var ids = Object.keys(index.topics || {});
  var found = null;
  var latest = -1;
  for (var i = 0; i < ids.length; i++) {
    var topic = index.topics[ids[i]];
    if (!reusableTopic(topic) || !openTopic(topic)) continue;
    var refs = Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
    for (var ri = 0; ri < refs.length; ri++) {
      var ref = refs[ri];
      if (ref.sessionStorageId !== storageId || ref.endEventIndex >= beforeEvent || ref.endEventIndex <= latest) continue;
      latest = ref.endEventIndex;
      found = topic;
    }
  }
  return found;
}

function recentHistoryTopic(index, history, topicRef) {
  var list = Array.isArray(history) ? history : [];
  for (var i = list.length - 1; i >= 0; i--) {
    var item = list[i] || {};
    if (item.type !== "user_message") continue;
    var ref = topicRef(item.coopTopicRef || item.topicRef);
    var topic = ref && index.topics[ref.topicId];
    if (reusableTopic(topic) && openTopic(topic)) return topic;
  }
  return null;
}

function turnCount(topic) {
  return Array.isArray(topic && topic.turnRefs) ? topic.turnRefs.length : 0;
}

// The best reuse candidate for `text` at the given overlap threshold, or null.
//
// Fully deterministic and clock-free. Candidates are visited in sorted id order
// and only ever displaced by a STRICTLY better one, ranked by: keyword overlap,
// then how established the conversation is (how many turn spans it already
// owns), then -- by construction of the sort -- the lowest topic id. There is
// deliberately no updatedAt term: a recency tie-break made the landing topic a
// function of wall-clock write order, so the same turn replayed against the same
// history could settle somewhere else. Turn count is the timestamp-free way to
// say the same useful thing -- fold a stray remark into the conversation the
// owner has actually been having, not into whichever fragment was written last.
//
// `requiredGroup` is the group the text itself infers. Passing it restricts
// reuse to topics in that group, which is how a WEAK single-word match is kept
// from dragging a turn across a project boundary on one coincidental word.
function bestExisting(index, text, preferredGroup, options, minOverlap, requiredGroup) {
  var input = matchableKeywords(keywords(text));
  if (input.length < 2) return null;
  var ids = Object.keys(index.topics || {}).sort();
  var best = null;
  var bestScore = 0;
  var bestTurns = 0;
  for (var i = 0; i < ids.length; i++) {
    var topic = index.topics[ids[i]];
    if (!reusableTopic(topic) || !usable(topic, preferredGroup, options.canAccessProject)) continue;
    if (requiredGroup && !groupMatches(topic, requiredGroup)) continue;
    var score = overlap(input, matchableKeywords(topicKeywords(topic)));
    if (score < minOverlap) continue;
    var turns = turnCount(topic);
    if (best && score <= bestScore && (score < bestScore || turns <= bestTurns)) continue;
    best = topic;
    bestScore = score;
    bestTurns = turns;
  }
  return best;
}

// Projection membership may overlap even though ingress has one primary route.
// Return every strongly supported open Thread deterministically and keep the
// fan-out bounded; a single shared term is never enough to add membership.
function overlappingTopics(index, text, preferredGroup, options) {
  var input = matchableKeywords(keywords(text));
  if (input.length < STRONG_OVERLAP) return [];
  var ids = Object.keys(index.topics || {}).sort();
  var matches = [];
  for (var i = 0; i < ids.length && matches.length < 4; i++) {
    var topic = index.topics[ids[i]];
    if (!reusableTopic(topic) || !usable(topic, preferredGroup, options.canAccessProject)) continue;
    if (overlap(input, matchableKeywords(topicKeywords(topic))) < STRONG_OVERLAP) continue;
    matches.push(topic);
  }
  return matches;
}

function matchedSeed(index, text, preferredGroup, options) {
  for (var i = 0; i < options.seeds.length; i++) {
    var seed = options.seeds[i];
    var candidate = index.topics[seed.id];
    if (options.matchesSeed(text, seed) && usable(candidate, preferredGroup, options.canAccessProject)) return candidate;
  }
  return null;
}

function explicitTopic(index, ref) {
  var topic = ref && index.topics[ref.topicId];
  var seen = {};
  while (topic && topic.status === "merged" && topic.mergedInto && !seen[topic.topicRef.topicId]) {
    seen[topic.topicRef.topicId] = true;
    topic = index.topics[topic.mergedInto.topicId];
  }
  return topic;
}

function projectStatus(item) {
  return item && typeof item.getStatus === "function" ? item.getStatus() : item || {};
}

function mentionedProjectRefs(text, options) {
  var value = " " + normalizeText(text) + " ";
  var projects = Array.isArray(options.projects) ? options.projects : [];
  var refs = [];
  for (var i = 0; i < projects.length; i++) {
    var item = projects[i];
    var status = projectStatus(item);
    var ref = projectIdentity.projectRef(item && item.projectId || status.projectId);
    if (!ref || options.canAccessProject && !options.canAccessProject(ref)) continue;
    var slug = normalizeText(status.slug || item && item.slug);
    var title = normalizeText(status.title || item && item.title);
    if ((!slug || value.indexOf(" " + slug + " ") === -1) && (!title || value.indexOf(" " + title + " ") === -1)) continue;
    if (!refs.some(function (entry) { return entry.projectId === ref.projectId; })) refs.push(ref);
  }
  return refs;
}

function inferredGroup(text, preferredGroup, options) {
  if (preferredGroup) return preferredGroup;
  var refs = mentionedProjectRefs(text, options);
  if (refs.length === 1) return options.normalizeGroup({ projectRef: refs[0] });
  return options.normalizeGroup(refs.length > 1 ? "cross_project" : "uncategorised");
}

function ensureAutomatic(index, text, group, options) {
  var metadata = derivedMetadata(text);
  var id = automaticTopicId(text, group);
  var topic = index.topics[id];
  if (topic) return { topic: topic, created: false };
  topic = options.makeTopic(id, metadata.title, group, "automatic", options.now(), metadata.keywords);
  index.topics[id] = topic;
  return { topic: topic, created: true };
}

// The one open catch-all a sealed or unroutable turn falls back to, or null when
// even the catch-all cannot take it. Deterministic by construction: there is
// exactly one catch-all seed, so the fallback never depends on iteration order,
// timestamps or scores.
function openCatchAll(index, preferredGroup, options) {
  var catchAll = index.topics["uncategorised-conversations"];
  return usable(catchAll, preferredGroup, options.canAccessProject) ? catchAll : null;
}

// Reuse first, mint last.
//
// The owner's single most-repeated complaint was topic sprawl: "ok SO WHY DO I
// HAVE |THIS MUCH TOPICS?!??", "we can't have 7 topics for one session", "topics
// don't look good at all". The cause was this function's old shape: any turn
// scoring fewer than two keyword overlaps against every stored topic fell
// straight through to ensureAutomatic. Ordinary follow-ups share exactly one
// word with the conversation they belong to, so nearly every turn bought its own
// permanent row -- 33 distinct topics for 53 requests, most holding one turn.
//
// So minting is now the exceptional branch at the bottom of a reuse ladder,
// tried in strict order:
//
//   0. low information            -> the conversation in progress, else catch-all
//   1. strong topical match (>=2)  -> that topic, across groups as before
//   2. seed match                  -> that seed
//   3. weak topical match (>=1)    -> that topic, but only within the same group
//   4. names no new subject        -> the conversation in progress, else catch-all
//   5. names a new subject         -> mint
//
// Every rung is a pure function of (index contents, text, group) -- no clock, no
// recency ordering, no iteration order -- so the same turn against the same
// index always lands in the same topic. Steps 0 and 4 consult the caller-supplied
// recent topic, which is derived from canonical history, not from timestamps.
function classifyIngress(index, text, preferredGroup, options) {
  var group = inferredGroup(text, preferredGroup, options);
  var recent = options.recentTopic;
  var fallback = null;
  var reusableRecent = reusableTopic(recent) && usable(recent, preferredGroup, options.canAccessProject) ? recent : null;
  if (lowInformation(text)) {
    if (reusableRecent) return { ok: true, topic: reusableRecent, created: false };
    // A low-information turn with nothing recent to attach to is noise, not a
    // topic of its own -- "Where are we now", "Does look like". Minting a
    // fresh single-turn automatic topic for it is exactly how throwaway
    // fragments used to end up pinned in the sidebar forever. It still lands
    // in the catch-all, so nothing is lost, but it never gets its own row.
    fallback = openCatchAll(index, preferredGroup, options);
    if (fallback) return { ok: true, topic: fallback, created: false };
  }
  var existing = bestExisting(index, text, preferredGroup, options, STRONG_OVERLAP, null);
  if (existing) return { ok: true, topic: existing, created: false };
  var seed = matchedSeed(index, text, preferredGroup, options);
  if (seed) return { ok: true, topic: seed, created: false };
  // A single shared content word is real evidence of relatedness -- it is how a
  // follow-up refers back to the thread it continues -- but it is weak, so it
  // may not carry a turn out of the group the text itself infers. Without that
  // restriction one coincidental word would pull a cross-project turn into a
  // single project's lens.
  var related = bestExisting(index, text, preferredGroup, options, WEAK_OVERLAP, group);
  if (related) return { ok: true, topic: related, created: false };
  // Nothing in the index matches, so this turn is either a genuinely new subject
  // or it is not about a subject at all. Only the former earns a row. The latter
  // continues the conversation in progress, exactly like a low-information turn,
  // and lands in the catch-all when there is no conversation to continue.
  if (!namesNewSubject(text)) {
    if (reusableRecent && groupMatches(reusableRecent, group)) return { ok: true, topic: reusableRecent, created: false };
    fallback = openCatchAll(index, preferredGroup, options);
    if (fallback) return { ok: true, topic: fallback, created: false };
    // No subject, no conversation, no catch-all. Minting below is the last
    // resort that keeps the contract "no canonical turn is unreachable"; the
    // promotion rules still withhold a one-turn row from the sidebar.
  }
  var automatic = ensureAutomatic(index, text, group, options);
  if (!usable(automatic.topic, group, options.canAccessProject)) {
    // The automatic topic this text derives from already exists and is closed
    // (or sits in a group this actor cannot reach). Closed topics never receive
    // new turns and never auto-reopen, so route deterministically to the open
    // catch-all instead; when that is unavailable too the turn gets no topic
    // membership rather than resurrecting a resolved lens.
    //
    // A topic minted moments ago is always open, so this only ever fires for a
    // pre-existing record. Drop a just-created-but-unusable topic so a rejected
    // classification cannot leak an unsaved row into the durable index.
    if (automatic.created) delete index.topics[automatic.topic.topicRef.topicId];
    fallback = openCatchAll(index, preferredGroup, options);
    if (fallback) return { ok: true, topic: fallback, created: false };
    return { ok: false, code: "topic_closed" };
  }
  return { ok: true, topic: automatic.topic, created: automatic.created };
}

function topicsForTurn(index, turn, options) {
  var matched = [];
  var explicitRef = options.topicRef(turn.topicRef);
  var explicit = explicitTopic(index, explicitRef);
  var seedMatched = false;
  // A match landed on a sealed (closed or merged) topic. The match is real, so
  // it still suppresses minting a brand-new automatic topic -- this turn is
  // about something already recorded, not a new subject -- but it grants no
  // membership. Such a turn falls through to the open catch-all below, and gets
  // no topic membership at all when even that is closed.
  var sealed = false;
  if (openTopic(explicit)) addUnique(matched, explicit);
  else if (explicit) sealed = true;
  for (var i = 0; i < options.seeds.length; i++) {
    var seed = options.seeds[i];
    var topic = index.topics[seed.id];
    if (!topic || !options.matchesSeed(turn.text, seed)) continue;
    if (openTopic(topic)) {
      addUnique(matched, topic);
      seedMatched = true;
    } else {
      sealed = true;
    }
  }
  // Internal execution narration is not conversation, so it must never be the
  // reason a topic exists. It still joins a topic it was explicitly routed to
  // -- a worker notification about Topic A belongs on Topic A -- and it still
  // lands in the catch-all so no history is orphaned; it simply cannot mint a
  // new automatic topic. Without this an internal-only turn, already dropped
  // from replay, could create a topic whose lens then renders empty.
  var ownerRelevant = topicRelevance.isOwnerRelevantTurn(turn);
  var created = false;
  var preferredGroup = turn.projectRef ? options.normalizeGroup({ projectRef: turn.projectRef }) : null;
  if (!explicit && !seedMatched && !sealed && ownerRelevant) {
    var classified = classifyIngress(index, turn.userText || turn.text, preferredGroup, options);
    if (classified.ok) {
      addUnique(matched, classified.topic);
      created = classified.created;
    }
  }
  if (ownerRelevant) {
    var overlaps = overlappingTopics(index, turn.userText || turn.text, preferredGroup, options);
    for (var oi = 0; oi < overlaps.length; oi++) addUnique(matched, overlaps[oi]);
  }
  // The catch-all is membership like any other, so it is sealed too: a closed
  // catch-all cannot absorb new turns. When that happens the turn keeps no topic
  // membership at all, which is the deliberate fail-closed end of the chain --
  // history is untouched, nothing is reopened, and nothing is misattributed.
  //
  // Group is deliberately NOT checked here. The catch-all exists so that no
  // canonical turn is ever orphaned, including project-routed ones, so scoping
  // it to the turn's group would strand exactly the turns it is there to hold.
  if (!seedMatched) {
    var catchAll = index.topics["uncategorised-conversations"];
    if (openTopic(catchAll)) addUnique(matched, catchAll);
  }
  return { topics: correctionEvidence.apply(index, turn, matched), created: created };
}

// Whether this automatic topic's title is exactly what auto-creation derived,
// i.e. nobody has renamed it since. The topicId is an immutable hash of the
// title text AT CREATION time (see automaticTopicId below), and rename() never
// touches the id -- only the title. Recomputing that same hash from the
// CURRENT title and comparing it to the id therefore proves whether the title
// has drifted from its own creation fingerprint. A retrofit must never rewrite
// a title that fails this check: that would silently overwrite a rename nobody
// asked to have undone.
function isUnmodifiedAutomaticTitle(topic) {
  if (!topic || topic.source !== "automatic") return false;
  var id = topic.topicRef && topic.topicRef.topicId;
  if (typeof id !== "string" || !/^auto-[a-f0-9]{24}$/.test(id)) return false;
  var digest = crypto.createHash("sha256").update(groupKey(topic.group) + "\n" + normalizeText(topic.title)).digest("hex");
  return id === "auto-" + digest.slice(0, 24);
}

module.exports = {
  STRONG_OVERLAP: STRONG_OVERLAP,
  WEAK_OVERLAP: WEAK_OVERLAP,
  automaticTopicId: automaticTopicId,
  classifyIngress: classifyIngress,
  namesNewSubject: namesNewSubject,
  // Exported so the retro consolidation pass groups by exactly the same signal
  // live classification does, instead of growing a second, drifting notion of
  // "these two topics are the same conversation".
  keywords: keywords,
  topicKeywords: topicKeywords,
  matchableKeywords: matchableKeywords,
  overlap: overlap,
  overlappingTopics: overlappingTopics,
  groupMatches: groupMatches,
  reusableTopic: reusableTopic,
  turnCount: turnCount,
  recentHistoryTopic: recentHistoryTopic,
  mostRecentTopic: mostRecentTopic,
  topicsForTurn: topicsForTurn,
  derivedMetadata: derivedMetadata,
  readableTitle: readableTitle,
  diagnosticTitle: diagnosticTitle,
  lowInformation: lowInformation,
  isUnmodifiedAutomaticTitle: isUnmodifiedAutomaticTitle,
  openTopic: openTopic,
};
