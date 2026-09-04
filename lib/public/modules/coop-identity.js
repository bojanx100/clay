// coop-identity.js - Owner-facing naming rules for the Coop surface.
//
// Two rules live here because both were regressions, and both have to hold on
// every render path that can write a title: session switch, sidebar re-render,
// the `info` frame on connect/reconnect, and restart.
//
//   1. Inside the Coop project the owner-facing identity is always "Coop".
//      "Lead" is Coop's internal power mode -- a routing/capability flag -- and
//      never a persona or a separate conversation, so it must not surface as a
//      title. Several writers used to fall back to the active session's title
//      or the project name, which let the header flip Coop <-> LEAD as the
//      owner selected All/a topic/a project or opened and closed the sidebar.
//
//   2. A topic is named by its canonical topic record, never by the snapshot
//      captured when the row was tapped and never by its internal id. The
//      snapshot goes stale across a projection rebuild, a reconnect, or a
//      history replay; the id is not owner-facing text.
//
// Pure functions only -- no DOM, no store, no imports. That keeps the rules
// testable on their own and lets every surface share one definition.

export var COOP_IDENTITY = "Coop";
export var COOP_PROJECT_SLUG = "lead";
export var UNTITLED_TOPIC = "Untitled Thread";

export function isCoopProjectSlug(slug) {
  return String(slug == null ? "" : slug).trim().toLowerCase() === COOP_PROJECT_SLUG;
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Resolves the project identity: the title bar, and the chat header whenever no
// topic is selected. Inside Coop the answer is fixed, so no caller can
// reintroduce the Coop/Lead flip by passing a session title through. Elsewhere
// the candidate wins and the caller's fallback applies.
export function coopHeaderTitle(slug, candidate, fallback) {
  if (isCoopProjectSlug(slug)) return COOP_IDENTITY;
  return trimmed(candidate) || trimmed(fallback) || "Clay";
}

// Once session_switched has acknowledged a session, its store title is the
// client authority. A later model refresh can rebuild the sidebar from the
// previous session_list before the new list arrives; reading that stale DOM row
// would put the old title back in the header. Before the first acknowledgement,
// the server-marked sidebar row remains the initial-paint fallback.
export function sessionHeaderCandidate(activeSessionId, activeSessionTitle, sidebarTitle) {
  if (activeSessionId != null) return trimmed(activeSessionTitle) || trimmed(sidebarTitle);
  return trimmed(sidebarTitle);
}

// The chat header names what the owner is reading, not the application.
//
//   * a selected topic  -> that topic's canonical title;
//   * All / Coop home   -> "Coop", the application identity;
//   * a project lens    -> "Coop"; the lens is a filter over Coop, not a place.
//
// Coop remains the identity everywhere else (title bar, tab title fallback);
// only this one element follows the lens. lensDisplay comes from
// activeCoopLensDisplay(), which resolves against the canonical projection, so
// the title here is canonical rather than a click-time snapshot.
export function coopChatHeaderTitle(slug, lensDisplay, candidate, fallback) {
  if (!isCoopProjectSlug(slug)) return trimmed(candidate) || trimmed(fallback) || "Clay";
  if (lensDisplay && lensDisplay.kind === "topic") {
    var topicTitle = trimmed(lensDisplay.title);
    // UNTITLED_TOPIC means the canonical record has not resolved yet. Showing
    // the application identity beats showing a placeholder as a heading; the
    // projection-version subscription repaints once the record lands.
    if (topicTitle && topicTitle !== UNTITLED_TOPIC) return topicTitle;
  }
  return COOP_IDENTITY;
}

export function topicIdOf(topicRef) {
  if (!topicRef) return "";
  return String(topicRef.topicId || topicRef.topicKey || topicRef.id || topicRef.key || "");
}

// Automatic topics are keyed "auto-" + a 24-char hex digest
// (lib/coop-topic-classification.js automaticTopicId). Matched exactly, so a
// real title like "auto-deadbeef" or "auto-scaling" is not mistaken for a key.
var GENERATED_TOPIC_ID = /^auto-[0-9a-f]{24}$/i;

// Internal identifiers must never reach owner-facing text. Only two shapes are
// treated as identifiers, and both are exact:
//
//   * the candidate IS the topic's own id, and
//   * the generated key shape above.
//
// Deliberately NOT a general "looks like a slug" test. Rejecting every lowercase
// hyphenated string would swallow real titles -- "follow-up", "post-mortem",
// "q3-planning" -- and degrade them to "Untitled Thread", which is a worse and
// far more likely failure than the narrow leak such a test would catch.
export function isInternalTopicIdentifier(value, topicId) {
  var text = trimmed(value);
  if (!text) return true;
  if (topicId && text === String(topicId)) return true;
  if (GENERATED_TOPIC_ID.test(text)) return true;
  return false;
}

// The canonical record wins; the snapshot is only a bridge for the frames
// between a tap and the next projection push. Anything that is an id, or
// missing, degrades to a neutral label instead of leaking internals.
//
// knownTopicId lets a caller supply the id it is holding (e.g. from a lens ref)
// for the case where the canonical record has not resolved: without it the
// exact-id check has nothing to compare against, and a snapshot that IS the id
// would be shown to the owner.
export function canonicalTopicTitle(topic, snapshotTitle, knownTopicId) {
  var id = (topic && topicIdOf(topic.topicRef)) || trimmed(knownTopicId);
  var canonical = trimmed(topic && topic.title);
  if (canonical && !isInternalTopicIdentifier(canonical, id)) return canonical;
  var snapshot = trimmed(snapshotTitle);
  if (snapshot && !isInternalTopicIdentifier(snapshot, id)) return snapshot;
  return UNTITLED_TOPIC;
}
