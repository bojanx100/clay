// The one place that decides how many owner requests a single Coop control
// call may carry, and the only supported way to split a larger set.
//
// This module exists because the bound used to be written twice: the Lead
// emitted an `answer_owner` decision carrying EVERY answerable request, and
// the MCP gate independently validated `link_owner_response` with a literal
// `.max(16)`. Nothing tied the two together, so the producer happily built a
// payload the consumer was guaranteed to refuse. With 20 unanswered requests
// in live state the gate returned a typed `too_big` for the whole call, the
// Lead's highest-priority decision could never be linked, and the backlog
// only grew -- silently, because a rejected link does not throw anywhere the
// owner can see it.
//
// Two rules follow, and both are deliberate:
//
//   * The cap is imported, never re-typed. A test asserts the producer and
//     the validator read the SAME constant, so raising one without the other
//     fails the suite instead of failing the owner.
//   * Over-cap sets are BATCHED, never truncated. Dropping owner questions on
//     the floor is worse than failing closed: the owner gets no answer and no
//     error either. Every request survives into exactly one batch, so the
//     caller makes several accepted calls rather than one refused one.
//
// Raising the number is not a fix. A bigger literal reintroduces exactly this
// deadlock at a higher threshold; batching removes the threshold as a failure
// mode at all.

// Per-call ceiling for arrays of owner-request targets: `link_owner_response`
// `requests`, and `reconcile_ledger_records` `ownerRequests`. Both are
// "a batch of owner requests to act on" and both are produced by the same
// answer-the-owner path, so they share one bound on purpose.
var MAX_OWNER_REQUEST_BATCH = 16;

// Topic dispositions are a different payload with a different producer, so
// they get their own named bound rather than borrowing the one above. Equal
// today; coupling them would invent an invariant nothing actually requires.
var MAX_TOPIC_BATCH = 16;

// Splits an ordered list into consecutive batches of at most `size`, so that
// concatenating the batches reproduces the input exactly: no element is
// dropped, duplicated or reordered. An empty input yields no batches (rather
// than one empty batch) because the gate refuses an empty `requests` array.
function batchBySize(items, size) {
  var list = Array.isArray(items) ? items : [];
  var limit = Number.isInteger(size) && size > 0 ? size : 1;
  var batches = [];
  for (var i = 0; i < list.length; i += limit) {
    batches.push(list.slice(i, i + limit));
  }
  return batches;
}

// The owner-request flavour of the split above, bound to the shared cap so a
// caller cannot pick its own size and drift from the gate again.
function batchOwnerRequests(items) {
  return batchBySize(items, MAX_OWNER_REQUEST_BATCH);
}

module.exports = {
  MAX_OWNER_REQUEST_BATCH: MAX_OWNER_REQUEST_BATCH,
  MAX_TOPIC_BATCH: MAX_TOPIC_BATCH,
  batchBySize: batchBySize,
  batchOwnerRequests: batchOwnerRequests,
};
