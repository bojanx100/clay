// Resolves an owner request's canonical chat turn inside the canonical Coop
// transcript.
//
// An owner turn used to be resolvable ONLY through requestRef.eventIndex, an
// absolute position in that transcript. Transcript delta coalescing (cf7f197ee1)
// rewrote the transcript from ~218k items to ~38k without repointing the stored
// indices, and coalescing happens during serialization, so the indices drift on
// every restart and never recover. Measured on live state: of 503 owner requests
// exactly ONE index still landed on its own ingress, 57 landed on an unrelated
// event and 445 pointed past the end.
//
// Because implementationAdmission requires the canonical event whenever an entry
// carries a requestRef -- and every entry does -- that made every owner decision
// in live state unadmittable. No owner could authorize any work at all.
//
// The index is derived positional data and it drifted. coopIngressId is the
// immutable identity the ingress was stamped with, so resolve by identity and
// keep the index only as a fast path. This is equivalent-or-narrower in
// authority by construction, not by argument: every writer of
// requestRef.eventIndex records the index of the item carrying that exact
// ingress (project-user-message-coop recordOwnerRequest, and
// coop-owner-request-backfill via ingressEvents), so the index always denoted
// the ingress-bearing event. Resolving by ingress returns that same event, and
// the caller re-checks the ingress on whatever comes back.

// Keyed on the history array itself, so a forked session that sliced its own
// history gets its own map even though it shares event objects.
var caches = new WeakMap();

function buildIndex(history) {
  var map = new Map();
  for (var i = 0; i < history.length; i++) {
    var candidate = history[i];
    if (!candidate || candidate.type !== "user_message" || !candidate.coopIngressId) continue;
    var key = String(candidate.coopIngressId);
    // A duplicated ingress id must never be resolved by guessing which turn the
    // owner meant. Nothing in live state carries one today, and the codebase
    // works to keep it that way (scheduled retries are stamped with
    // coopContinuationIngressId precisely so they are not mistaken for a second
    // copy of the same ingress) -- but uniqueness is not enforced anywhere, so
    // this records the collision and lets the caller fail closed.
    map.set(key, map.has(key) ? null : { event: candidate, index: i });
  }
  return { length: history.length, map: map };
}

// Invalidation cannot key on length alone. An in-place removal that also appends
// leaves the length unchanged while the owner turn is gone from the transcript,
// and a cache keyed only on length would keep serving that removed turn -- which
// on this gate means a deleted owner turn could still authorize a dispatch.
// Verifying the hit still sits where it was indexed closes that off exactly,
// while a legitimately relocated event just costs one rebuild.
function lookup(history, ingressId) {
  if (!Array.isArray(history) || !ingressId) return null;
  var cached = caches.get(history);
  if (!cached || cached.length !== history.length) {
    cached = buildIndex(history);
    caches.set(history, cached);
  }
  var hit = cached.map.get(String(ingressId));
  if (hit && history[hit.index] !== hit.event) {
    cached = buildIndex(history);
    caches.set(history, cached);
    hit = cached.map.get(String(ingressId));
  }
  return hit || null;
}

function resolveByIngressId(history, ingressId) {
  var hit = lookup(history, ingressId);
  return hit ? hit.event : null;
}

// The same resolution, returning the owner turn's position instead of the turn
// itself. Callers that range-test an owner request against a Thread turn's
// start/end event index need the position, and the stored
// requestRef.eventIndex is exactly the value that drifted. Resolution,
// caching and the duplicate-ingress fail-closed behaviour are shared with
// resolveByIngressId; -1 keeps "not resolvable" distinguishable from index 0.
function resolveIndexByIngressId(history, ingressId) {
  var hit = lookup(history, ingressId);
  return hit ? hit.index : -1;
}

module.exports = {
  resolveByIngressId: resolveByIngressId,
  resolveIndexByIngressId: resolveIndexByIngressId,
};
