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

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function derivedMetadata(text) {
  var words = keywords(text).slice(0, 5);
  var title = words.map(titleCase).join(" ");
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

function usable(topic, preferredGroup, canAccessProject) {
  return !!(topic && topic.status === "open" && groupMatches(topic, preferredGroup) && projectAllowed(topic, canAccessProject));
}

function reusableTopic(topic) {
  return !!(topic && topic.topicRef && topic.topicRef.topicId !== "uncategorised-conversations" &&
    (topic.source === "automatic" || topic.source === "manual" || topic.source === "split"));
}

function topicKeywords(topic) {
  var values = Array.isArray(topic && topic.keywords) ? topic.keywords.slice() : [];
  var titleWords = keywords(topic && topic.title);
  for (var i = 0; i < titleWords.length; i++) {
    if (values.indexOf(titleWords[i]) === -1) values.push(titleWords[i]);
  }
  return values;
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
    if (!reusableTopic(topic) || topic.status !== "open") continue;
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
    if (reusableTopic(topic) && topic.status === "open") return topic;
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

function classifyIngress(index, text, preferredGroup, options) {
  var group = inferredGroup(text, preferredGroup, options);
  var recent = options.recentTopic;
  if (lowInformation(text)) {
    if (reusableTopic(recent) && usable(recent, preferredGroup, options.canAccessProject)) {
      return { ok: true, topic: recent, created: false };
    }
    // A low-information turn with nothing recent to attach to is noise, not a
    // topic of its own -- "Where are we now", "Does look like". Minting a
    // fresh single-turn automatic topic for it is exactly how throwaway
    // fragments used to end up pinned in the sidebar forever. It still lands
    // in the catch-all, so nothing is lost, but it never gets its own row.
    var catchAll = index.topics["uncategorised-conversations"];
    if (usable(catchAll, preferredGroup, options.canAccessProject)) {
      return { ok: true, topic: catchAll, created: false };
    }
  }
  var existing = bestExisting(index, text, preferredGroup, options);
  if (existing) return { ok: true, topic: existing, created: false };
  var seed = matchedSeed(index, text, preferredGroup, options);
  if (seed) return { ok: true, topic: seed, created: false };
  var automatic = ensureAutomatic(index, text, group, options);
  if (!usable(automatic.topic, group, options.canAccessProject)) return { ok: false, code: "topic_closed" };
  return { ok: true, topic: automatic.topic, created: automatic.created };
}

function topicsForTurn(index, turn, options) {
  var matched = [];
  var explicitRef = options.topicRef(turn.topicRef);
  var explicit = explicitTopic(index, explicitRef);
  var seedMatched = false;
  if (explicit && explicit.status !== "merged") addUnique(matched, explicit);
  for (var i = 0; i < options.seeds.length; i++) {
    var seed = options.seeds[i];
    var topic = index.topics[seed.id];
    if (topic && topic.status !== "merged" && options.matchesSeed(turn.text, seed)) {
      addUnique(matched, topic);
      seedMatched = true;
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
  if (!explicit && !seedMatched && ownerRelevant) {
    var preferredGroup = turn.projectRef ? options.normalizeGroup({ projectRef: turn.projectRef }) : null;
    var classified = classifyIngress(index, turn.userText || turn.text, preferredGroup, options);
    if (classified.ok) {
      addUnique(matched, classified.topic);
      created = classified.created;
    }
  }
  if (!seedMatched) addUnique(matched, index.topics["uncategorised-conversations"]);
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
  lowInformation: lowInformation,
  isUnmodifiedAutomaticTitle: isUnmodifiedAutomaticTitle,
};
