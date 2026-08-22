// Resolves the canonical `done` event that answered an owner request, by
// identity rather than by position.
//
// The request side of this problem is solved in coop-owner-event-resolution.js:
// an owner turn is stamped with an immutable coopIngressId, so the drifting
// requestRef.eventIndex is only a fast path. The response side had no identity
// at all. writeSessionJsonlSync coalesces consecutive mergeable `delta` events
// into a single transcript line while session.history keeps them all, so every
// reload rebases session.history onto the coalesced file and every absolute
// index stored into it rots. Measured on live state: of 567 stored
// response.responseRef.eventIndex values only 9 still landed on a clean `done`.
//
// The anchor cannot be the `done` itself. A done event is literally
// `{type, code, _ts}` -- it carries no id of any kind, and there is nowhere to
// put one without rewriting history that is already on disk. What the
// transcript does carry is `message_uuid` events, `{type, uuid, messageType,
// _ts}`, emitted by sdk-message-processor for each user and assistant message.
// On the live Lead transcript all 6965 of them are distinct. So the durable
// identity of a `done` is borrowed from the last `message_uuid` before it: the
// assistant message whose completion that `done` reports.
//
// Two boundaries make that borrowing safe:
//
//   * the backward scan stops at a `user_message`. A `done` at the very start
//     of a turn must not borrow the previous turn's uuid and thereby claim to
//     be a response inside a turn it does not belong to.
//   * a uuid that anchors more than one `done` resolves to nothing. Ten uuids
//     on live state do (consecutive dones with no assistant message between
//     them), and guessing which one answered the owner is exactly the fail-open
//     move this module exists to avoid.
//
// Coverage on the live transcript: 1971 of 2231 dones have an anchor. Of the
// 260 without one, 118 are error dones -- which carry a `code` and can never be
// a valid response anchor, because responseProof requires `!event.code` -- and
// only 9 are substantive. An absent anchor is not a failure: it degrades to the
// index-only behaviour that existed before, so this is additive identity and
// never new authority.

// Keyed on the history array itself, so a forked session that sliced its own
// history gets its own map even though it shares event objects.
var caches = new WeakMap();

// The uuid that anchors the `done` at doneIndex, or "" when there is none.
//
// Deliberately strict about the target being a `done`: every writer of a
// responseRef records the index of the event that ended the turn, so anchoring
// anything else would mint an identity for a position no reader will ever ask
// about.
function anchorForDone(history, doneIndex) {
  if (!Array.isArray(history) || !Number.isInteger(doneIndex)) return "";
  var target = history[doneIndex];
  if (!target || target.type !== "done") return "";
  for (var i = doneIndex - 1; i >= 0; i--) {
    var event = history[i];
    if (!event) continue;
    // The turn boundary. Borrowing across it would let a done claim identity
    // from an earlier turn's assistant message.
    if (event.type === "user_message") return "";
    if (event.type !== "message_uuid") continue;
    if (typeof event.uuid === "string" && event.uuid) return event.uuid;
  }
  return "";
}

// One forward pass mirroring anchorForDone: carry the most recent message_uuid,
// drop it at every turn boundary, and attribute it to each `done` that follows.
// Error dones are indexed too. They can never satisfy responseProof, but they
// can collide with a good done on the same anchor, and a collision must fail
// closed rather than quietly resolve to the survivor.
function buildIndex(history) {
  var map = new Map();
  var anchor = "";
  for (var i = 0; i < history.length; i++) {
    var event = history[i];
    if (!event) continue;
    if (event.type === "user_message") {
      anchor = "";
      continue;
    }
    if (event.type === "message_uuid") {
      if (typeof event.uuid === "string" && event.uuid) anchor = event.uuid;
      continue;
    }
    if (event.type !== "done" || !anchor) continue;
    map.set(anchor, map.has(anchor) ? null : { event: event, index: i });
  }
  return { length: history.length, map: map };
}

// Invalidation cannot key on length alone, for the same reason it cannot in
// coop-owner-event-resolution: an in-place removal that also appends leaves the
// length unchanged while the answering event is gone from the transcript, and a
// cache keyed only on length would keep serving a `done` that no longer exists
// as proof that the owner was answered. Verifying the hit still sits where it
// was indexed closes that off; a legitimately relocated event costs a rebuild.
function lookup(history, messageUuid) {
  if (!Array.isArray(history) || typeof messageUuid !== "string" || !messageUuid) return null;
  var cached = caches.get(history);
  if (!cached || cached.length !== history.length) {
    cached = buildIndex(history);
    caches.set(history, cached);
  }
  var hit = cached.map.get(messageUuid);
  if (hit && history[hit.index] !== hit.event) {
    cached = buildIndex(history);
    caches.set(history, cached);
    hit = cached.map.get(messageUuid);
  }
  return hit || null;
}

// The index of the `done` this uuid anchors, or -1. -1 keeps "not resolvable"
// distinguishable from index 0, and is what an absent, unknown or duplicated
// anchor all return: this resolver never guesses.
function resolveDoneByAnchor(history, messageUuid) {
  var hit = lookup(history, messageUuid);
  return hit ? hit.index : -1;
}

module.exports = {
  anchorForDone: anchorForDone,
  resolveDoneByAnchor: resolveDoneByAnchor,
};
