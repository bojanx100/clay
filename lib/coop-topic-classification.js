// Deterministic, body-free classification for canonical Coop topic lenses.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var topicRelevance = require("./coop-topic-relevance");

var STOP_WORDS = {
  a: true, an: true, and: true, are: true, as: true, at: true, be: true, by: true,
  can: true, do: true, for: true, from: true, have: true, help: true, i: true,
  in: true, is: true, it: true, me: true, my: true, of: true, on: true, or: true,
  please: true, the: true, this: true, to: true, we: true, with: true, you: true,
  // Common English function/modal/auxiliary words. Without these, short or
  // conversational owner phrasing keeps grammatically-empty leftovers (e.g.
  // "should", "would", "been", "none") as if they were content, which reads as
  // a scrambled fragment rather than a title.
  was: true, were: true, been: true, being: true, none: true, not: true,
  what: true, does: true, should: true, would: true, could: true, will: true,
  shall: true, must: true, might: true, want: true, need: true, going: true,
  got: true, get: true, gets: true, getting: true, make: true, about: true,
  that: true, these: true, those: true, there: true, here: true, when: true,
  where: true, why: true, how: true, who: true, which: true, then: true,
  but: true, than: true, too: true, also: true, into: true, over: true,
  under: true, again: true, once: true, still: true, even: true, only: true,
  mean: true, means: true, meant: true, just: true, some: true, any: true,
  all: true, using: true, use: true, used: true, one: true, way: true,
  // Contractions collapse to a single alnum token once the apostrophe is
  // dropped (see normalizeText): "don't" -> "dont", "isn't" -> "isnt". Without
  // these entries the stripped apostrophe used to split the word in two,
  // leaving an orphan fragment like "don" behind as spurious content.
  dont: true, isnt: true, wasnt: true, arent: true, wont: true, cant: true,
  wouldnt: true, couldnt: true, shouldnt: true, doesnt: true, hasnt: true,
  hadnt: true, havent: true, werent: true, im: true, ive: true, ill: true,
  id: true, its: true, thats: true, lets: true, youre: true, theyre: true,
  weve: true, youve: true, theyve: true, whats: true, thered: true,
};
var FOLLOW_UP_WORDS = { yes: true, yep: true, yeah: true, thanks: true, thank: true, continue: true, proceed: true, okay: true, ok: true, sure: true, more: true, next: true };

function normalizeText(value) {
  // Apostrophes are dropped (not replaced with whitespace) so a contraction
  // collapses into a single token -- "don't" -> "dont" -- instead of
  // splitting into a real word plus an orphan fragment ("don" + "t") that
  // used to survive filtering and read as a scrambled extra word in titles.
  return String(value || "").toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function keywords(value) {
  var words = normalizeText(value).split(" ");
  var found = [];
  var seen = {};
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    if (!word || word.length < 3 || STOP_WORDS[word] || seen[word]) continue;
    seen[word] = true;
    found.push(word);
  }
  return found;
}

// Leading conversational filler that carries no topic meaning. Only ever
// stripped from the FRONT of a title excerpt -- inner words are never removed
// or reordered, so the excerpt stays a readable phrase the owner actually
// wrote rather than a bag of keywords.
var BOILERPLATE_LEAD = {
  ok: true, okay: true, so: true, well: true, hey: true, hi: true, hello: true,
  yes: true, yeah: true, yea: true, yep: true, please: true, thanks: true,
  thank: true, alright: true, hmm: true, um: true, uh: true, oh: true,
  actually: true, basically: true, anyway: true,
};

var TITLE_MAX_WORDS = 8;
var TITLE_MAX_CHARS = 60;

// Deterministic, readable title from the owner's own words: the first
// sentence/clause with word order and contractions preserved, boilerplate
// stripped from the front only, bounded at a word boundary. Never reorders,
// dedupes, or stopword-filters tokens -- that produced word salad ("Taken
// Idle Didnt Take Messages") instead of a human topic name.
function readableTitle(text) {
  var raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  var sentence = raw.split(/[.!?]+\s+|\n+|\s+--\s+|\s+—\s+/)[0] || raw;
  var words = sentence.split(" ");
  var start = 0;
  while (start < words.length) {
    var lead = words[start].toLowerCase().replace(/[^a-z0-9']/g, "");
    if (lead && BOILERPLATE_LEAD[lead]) start += 1;
    else break;
  }
  if (start >= words.length) start = 0;
  words = words.slice(start);
  var truncated = false;
  if (words.length > TITLE_MAX_WORDS) { words = words.slice(0, TITLE_MAX_WORDS); truncated = true; }
  var title = words.join(" ");
  while (title.length > TITLE_MAX_CHARS && words.length > 1) {
    words.pop();
    title = words.join(" ");
    truncated = true;
  }
  title = title.replace(/[\s,;:.!?…]+$/, "");
  if (!title) return "";
  if (truncated) title += "…";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// Vague verbs and fillers that keep a clause from naming a subject on its
// own: "Can you implement that", "It's all working", "Does this look like
// it". They are perfectly good words INSIDE a title -- they just do not count
// as evidence that a clause is about something concrete.
var VAGUE_WORDS = {
  look: true, like: true, know: true, think: true, mean: true, want: true,
  need: true, tell: true, say: true, see: true, give: true, take: true,
  taken: true, working: true, done: true, finished: true, good: true,
  things: true, stuff: true, help: true, implement: true, doing: true,
  make: true, made: true, whats: true, dont: true, didnt: true, cant: true,
  wont: true, youre: true, gonna: true, going: true, still: true,
};

function splitClauses(text) {
  return String(text || "").replace(/\s+/g, " ").trim()
    .split(/[.!?]+\s+|\n+|\s+--\s+|\s+—\s+/).filter(Boolean);
}

// A clause is diagnostic when it carries at least two concrete content words
// after stopwords, leading boilerplate, and vague verbs are set aside -- the
// minimum for a title to name a subject instead of a deictic owner utterance
// ("Yea, so", "Does this look like it").
function clauseInformative(clause) {
  var words = keywords(clause);
  var count = 0;
  for (var i = 0; i < words.length; i++) {
    if (!VAGUE_WORDS[words[i]] && !BOILERPLATE_LEAD[words[i]]) count += 1;
  }
  return count;
}

// The first clause of `text` that names a concrete subject, rendered through
// readableTitle. Returns "" when no clause is diagnostic, so callers can fall
// back or route the fragment to the catch-all instead of keeping a vague
// owner-utterance title.
function diagnosticTitle(text) {
  var parts = splitClauses(text);
  for (var i = 0; i < parts.length; i++) {
    if (clauseInformative(parts[i]) >= 2) {
      var title = readableTitle(parts[i]);
      if (title) return title;
    }
  }
  return "";
}

function derivedMetadata(text) {
  var words = keywords(text).slice(0, 5);
  var title = diagnosticTitle(text) || readableTitle(text);
  return { title: title || "Automatic conversation", keywords: words };
}

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

function lowInformation(text) {
  var words = keywords(text);
  if (words.length <= 2) return true;
  for (var i = 0; i < words.length; i++) if (!FOLLOW_UP_WORDS[words[i]]) return false;
  return true;
}

function bestExisting(index, text, preferredGroup, options) {
  var input = keywords(text);
  if (input.length < 2) return null;
  var ids = Object.keys(index.topics || {}).sort();
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < ids.length; i++) {
    var topic = index.topics[ids[i]];
    if (!reusableTopic(topic) || !usable(topic, preferredGroup, options.canAccessProject)) continue;
    var score = overlap(input, topicKeywords(topic));
    if (score < 2 || score < bestScore) continue;
    if (!best || score > bestScore || (topic.updatedAt || 0) > (best.updatedAt || 0)) {
      best = topic;
      bestScore = score;
    }
  }
  return best;
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

function classifyIngress(index, text, preferredGroup, options) {
  var group = inferredGroup(text, preferredGroup, options);
  var recent = options.recentTopic;
  var fallback = null;
  if (lowInformation(text)) {
    if (reusableTopic(recent) && usable(recent, preferredGroup, options.canAccessProject)) {
      return { ok: true, topic: recent, created: false };
    }
    // A low-information turn with nothing recent to attach to is noise, not a
    // topic of its own -- "Where are we now", "Does look like". Minting a
    // fresh single-turn automatic topic for it is exactly how throwaway
    // fragments used to end up pinned in the sidebar forever. It still lands
    // in the catch-all, so nothing is lost, but it never gets its own row.
    fallback = openCatchAll(index, preferredGroup, options);
    if (fallback) return { ok: true, topic: fallback, created: false };
  }
  var existing = bestExisting(index, text, preferredGroup, options);
  if (existing) return { ok: true, topic: existing, created: false };
  var seed = matchedSeed(index, text, preferredGroup, options);
  if (seed) return { ok: true, topic: seed, created: false };
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
  return { topics: matched, created: created };
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
  automaticTopicId: automaticTopicId,
  classifyIngress: classifyIngress,
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
