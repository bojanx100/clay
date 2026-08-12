// The owner's own words -> a title, keywords, and a judgement about whether a
// turn names a subject at all. Split out of coop-topic-classification.js, which
// grew past the 500-line module limit; that file keeps ROUTING (which stored
// topic does this turn join), this one keeps DERIVATION (what do these words
// say). Nothing here reads the index, a session, a clock or a file: every
// function is a pure function of the text it is handed.
//
// The header comments below record several past owner-visible regressions --
// word-salad titles, orphaned contraction fragments, throwaway fragments pinned
// in the sidebar. They moved with the code they explain; do not reintroduce any
// of them.

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

// The minting bar: a turn must name a subject in at least two real words before
// it may claim a topic row of its own. See namesNewSubject.
var MIN_SUBJECT_WORDS = 2;

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

// Words that are perfectly good INSIDE a title but are never evidence that a
// turn introduces a subject the index has not seen yet: conversational deixis,
// meta-talk about the conversation itself, bare temporal adverbs and
// quantifiers. Deliberately a SEPARATE table from VAGUE_WORDS, which feeds
// clauseInformative and therefore every derived title: widening VAGUE_WORDS to
// get a stricter minting bar would silently re-title existing topics and change
// what the retrofit derives. This table is consulted only by namesNewSubject and
// matchableKeywords -- routing decisions -- so the minting bar can be raised and
// the matching signal cleaned up without touching a single title.
var NON_SUBJECT_WORDS = {
  now: true, never: true, always: true, already: true, yet: true, soon: true,
  answered: true, answer: true, asked: true, ask: true, said: true, says: true,
  told: true, thing: true, somehow: true, anymore: true, everything: true,
  anything: true, nothing: true, something: true, sometimes: true,
  actually: true, really: true, maybe: true, probably: true, because: true,
  thought: true, guess: true, sure: true, better: true, worse: true,
  more: true, less: true, other: true, another: true, same: true,
  couple: true, bunch: true, many: true, much: true, few: true, lot: true,
  everyone: true, everybody: true, nobody: true, someone: true, somebody: true,
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

// How many words in this clause could plausibly NAME something new. A subject
// word has to be a word: purely alphabetic, so a raw session uuid
// ("019ff342-2aff-7be2-8295-f1a0a0565e3c") scores zero instead of reading as
// five content tokens and buying itself a permanent sidebar row.
function subjectWordCount(clause) {
  var words = keywords(clause);
  var count = 0;
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    if (!/^[a-z]+$/.test(word)) continue;
    if (VAGUE_WORDS[word] || BOILERPLATE_LEAD[word] || NON_SUBJECT_WORDS[word]) continue;
    count += 1;
  }
  return count;
}

// Whether this turn introduces a subject at all -- the one thing that can
// justify minting a brand-new automatic topic once every reuse path has
// declined. It is deliberately the SAME shape of test diagnosticTitle uses to
// decide a clause can name a topic, tightened to real words, so a turn can
// never mint a topic the title machinery would refuse to name.
//
// This is the bar the owner was complaining about: "we can't have 7 topics for
// one session". A follow-up, a meta-question about the conversation, an
// identifier, an acknowledgement -- none of them name a new subject, so none of
// them mints. Only a clause carrying at least two genuine, non-deictic content
// words does, and only after it has failed to match anything already in the
// index.
function namesNewSubject(text) {
  var parts = splitClauses(text);
  for (var i = 0; i < parts.length; i++) {
    if (subjectWordCount(parts[i]) >= MIN_SUBJECT_WORDS && readableTitle(parts[i])) return true;
  }
  return false;
}

function derivedMetadata(text) {
  var words = keywords(text).slice(0, 5);
  var title = diagnosticTitle(text) || readableTitle(text);
  return { title: title || "Automatic conversation", keywords: words };
}

// The subset of a keyword list that can serve as EVIDENCE that two turns are
// about the same thing.
//
// Stored keywords are simply the owner's first five content words, which
// routinely include deictic filler: "now", "maybe", "because", "another". Two
// turns sharing one of those share a habit of phrasing, not a subject. Left
// unfiltered they produced exactly the wrong retro merges -- "Now what about the
// stuff you never answered" folded into "Theres's a bunch of coop sessions now"
// on the strength of the word "now".
//
// Titles and stored keywords are deliberately NOT changed by this: it is applied
// only where overlap is read as a matching signal, so nothing the owner sees
// moves and no topic id is affected.
function matchableKeywords(words) {
  var list = Array.isArray(words) ? words : [];
  var found = [];
  for (var i = 0; i < list.length; i++) {
    if (!NON_SUBJECT_WORDS[list[i]]) found.push(list[i]);
  }
  return found;
}

// A turn with nothing to say on its own: two content words or fewer, or nothing
// but acknowledgement. Such a turn continues whatever conversation is already in
// progress rather than starting one.
function lowInformation(text) {
  var words = keywords(text);
  if (words.length <= 2) return true;
  for (var i = 0; i < words.length; i++) if (!FOLLOW_UP_WORDS[words[i]]) return false;
  return true;
}

module.exports = {
  STOP_WORDS: STOP_WORDS,
  FOLLOW_UP_WORDS: FOLLOW_UP_WORDS,
  BOILERPLATE_LEAD: BOILERPLATE_LEAD,
  VAGUE_WORDS: VAGUE_WORDS,
  NON_SUBJECT_WORDS: NON_SUBJECT_WORDS,
  MIN_SUBJECT_WORDS: MIN_SUBJECT_WORDS,
  normalizeText: normalizeText,
  keywords: keywords,
  readableTitle: readableTitle,
  splitClauses: splitClauses,
  clauseInformative: clauseInformative,
  diagnosticTitle: diagnosticTitle,
  subjectWordCount: subjectWordCount,
  namesNewSubject: namesNewSubject,
  matchableKeywords: matchableKeywords,
  derivedMetadata: derivedMetadata,
  lowInformation: lowInformation,
};
