// coop-reply-anchor.js - Renders the reply-anchor chip on a message that was
// sent from a Coop topic lens.
//
// The server (lib/coop-topic-reply-anchor.js) computes and persists the
// logical parent of such a message once, at ingress, on the `coopTopicAnchor`
// field. That value reaches the browser unchanged on both the live echo and
// history replay. This module is the read-time half: it re-derives the same
// fail-closed gates the server applies before trusting a persisted anchor, so
// a client that disagrees about validity renders nothing rather than a lie.
//
// Fail closed, same as the server: an unrecognised anchor shape, or an anchor
// whose topicId does not match the message's own coopTopicRef, is discarded
// rather than partially honoured. The tempting shortcut -- render whatever
// topicId the anchor claims, regardless of the message's own ref -- is exactly
// the cross-topic misattribution this exists to prevent.

import { store } from './store.js';
import { iconHtml, refreshIcons } from './icons.js';
import { findGlobalCoopTopic } from './global-coop-projection.js';

// Bumped in lockstep with ANCHOR_VERSION in lib/coop-topic-reply-anchor.js. A
// reader that does not recognise the version ignores the anchor (fail closed)
// instead of guessing its layout.
var ANCHOR_VERSION = 1;

// Reused from app-messages-history.focusCanonicalHistoryEvent so a chip jump
// and a history-replay jump land on the exact same visual treatment.
var HIGHLIGHT_CLASS = "message-blink";
var HIGHLIGHT_MS = 2000;

var FALLBACK_TITLE = "Reply in Thread";

// Reads a persisted anchor back into its canonical shape. Mirrors
// coop-topic-reply-anchor.normalizeReplyAnchor. Anything unrecognised --
// wrong version, missing ids, non-integer index -- is discarded rather than
// partially honoured.
export function normalizeReplyAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== ANCHOR_VERSION) return null;
  var topicId = typeof value.topicId === "string" ? value.topicId.trim() : "";
  var storageId = typeof value.sessionStorageId === "string" ? value.sessionStorageId.trim() : "";
  if (!topicId || !storageId || !Number.isInteger(value.eventIndex) || value.eventIndex < 0) return null;
  return {
    version: ANCHOR_VERSION,
    topicId: topicId,
    sessionStorageId: storageId,
    eventIndex: value.eventIndex,
    type: typeof value.type === "string" ? value.type : "",
    ts: typeof value.ts === "number" ? value.ts : null,
    clientMessageId: typeof value.clientMessageId === "string" ? value.clientMessageId : "",
  };
}

function topicIdOfRef(ref) {
  return ref && typeof ref === "object" && typeof ref.topicId === "string" ? ref.topicId.trim() : "";
}

// The anchor a message may be rendered with, or null for plain general chat.
// Two independent gates, each failing closed on its own:
//   1. the message must carry a recognisable anchor at all,
//   2. the anchor must claim the SAME topic as the message's own
//      coopTopicRef -- a mismatch is cross-topic attribution and is refused
//      outright, never re-pointed.
export function replyAnchorFor(msg) {
  if (!msg || typeof msg !== "object") return null;
  var anchor = normalizeReplyAnchor(msg.coopTopicAnchor);
  if (!anchor) return null;
  if (anchor.topicId !== topicIdOfRef(msg.coopTopicRef)) return null;
  return anchor;
}

// The topic lens the transcript is currently showing, if any.
function activeTopicId() {
  var ref = store.get("activeCoopTopicRef");
  return topicIdOfRef(ref);
}

function chipLabel(anchor) {
  var topic = findGlobalCoopTopic({ topicId: anchor.topicId });
  var title = topic && typeof topic.title === "string" ? topic.title.trim() : "";
  return title ? "Reply in " + title : FALLBACK_TITLE;
}

function jumpToTarget(target) {
  target.scrollIntoView({ block: "center" });
  target.classList.add(HIGHLIGHT_CLASS);
  setTimeout(function () { target.classList.remove(HIGHLIGHT_CLASS); }, HIGHLIGHT_MS);
}

function wireJump(chip, target) {
  chip.setAttribute("role", "button");
  chip.setAttribute("tabindex", "0");
  chip.addEventListener("click", function () { jumpToTarget(target); });
  chip.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    jumpToTarget(target);
  });
}

function buildChip(anchor, target) {
  var chip = document.createElement("div");
  chip.className = "coop-reply-anchor";
  chip.innerHTML = iconHtml("corner-up-left");
  var label = document.createElement("span");
  label.className = "coop-reply-anchor-label";
  label.textContent = chipLabel(anchor);
  chip.appendChild(label);
  if (target) wireJump(chip, target);
  return chip;
}

// Prepends the reply-anchor chip into `el`'s bubble content when `msg` names
// a valid, same-topic anchor. Safe to call twice on the same element: a chip
// already present is left alone rather than duplicated. Returns true only
// when a chip was newly rendered.
export function applyCoopReplyAnchor(el, msg) {
  if (!el || typeof el.querySelector !== "function") return false;
  var anchor = replyAnchorFor(msg);
  if (!anchor) return false;
  // Inside the topic's own lens the chip would name the conversation the owner
  // is already looking at. Suppressed here rather than by a lens-scoped CSS
  // rule: exactly one such rule exists (the Main internal-relevance filter),
  // and adding another would weaken the guarantee that All hides nothing.
  // Switching lens re-replays the transcript from scratch, so this decision is
  // re-made whenever the answer could have changed.
  if (anchor.topicId === activeTopicId()) return false;
  if (el.querySelector(".coop-reply-anchor")) return false;
  var host = el.querySelector(".dm-bubble-content") || el;
  var messagesEl = document.getElementById("messages");
  var target = messagesEl ? messagesEl.querySelector('[data-history-index="' + anchor.eventIndex + '"]') : null;
  var chip = buildChip(anchor, target);
  // Directly above the message text, below the sender/time header: the chip
  // qualifies what was said, it does not qualify who said it.
  host.insertBefore(chip, host.querySelector(".bubble") || host.firstChild);
  el.dataset.coopReplyTopic = anchor.topicId;
  el.dataset.coopReplyEventIndex = String(anchor.eventIndex);
  // The chip is inserted after addUserMessage already asked for an icon pass.
  // That pass is rAF-debounced and would still catch this node in practice,
  // but a caller decorating an element outside that window would be left with
  // a bare <i data-lucide> placeholder, so ask again rather than rely on it.
  refreshIcons();
  return true;
}
