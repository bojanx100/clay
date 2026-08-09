// Durable topic-level owner dispositions.
//
// Two writers, both explicit:
//
//   1. The versioned, index-stamped disposition backfill. Historical topics
//      predate durable topic->task links (production evidence: all 44 topics
//      had relatedExecutions: [] and zero orchestration tasks carried a
//      coopTopicRef), so their resolution cannot be proven from task records.
//      The backfill records that fact durably -- status "needs_input", source
//      "unlinked_historical" -- instead of guessing. It NEVER writes "done":
//      Done requires owner acceptance evidence, and a backfill has none.
//
//   2. An explicit owner decision (coop_topic_disposition). The owner, and
//      only the owner, may mark a topic done, reopen it, request changes, or
//      acknowledge it as waiting. Each decision replaces the record whole, so
//      the current disposition always names its author, verb and time.
//
// The disposition is an input to coop-topic-state, never the whole answer:
// live task evidence outranks it, so accepting a topic done does not silence a
// task that later starts running or blocks on a question there.

var DISPOSITION_SCHEMA_VERSION = 1;

var MAX_NOTE = 500;
var UNICODE_SEPARATORS = /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
var INVISIBLE_OR_BIDI = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function cleanNote(value) {
  return String(value == null ? "" : value)
    .replace(/[\0-\037\177]+/g, " ")
    .replace(INVISIBLE_OR_BIDI, "")
    .replace(UNICODE_SEPARATORS, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, MAX_NOTE);
}

function topicIdOf(ref) {
  if (!ref) return "";
  return String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
}

// The owner decision verbs. Deliberately topic-scoped and disposition-only:
// none of them creates work, closes a topic, or touches a task record. A
// task-linked topic is decided through the existing task-scoped decision
// system (coop-action-decision), which writes ownerAcceptance -- real task
// evidence that then outranks any disposition here.
var DECISION_STATUS = {
  accept_done: "done",
  request_changes: "needs_input",
  keep_waiting: "needs_input",
  reopen: "needs_input",
};

function decisionRecord(verb, note, now, revision) {
  return {
    status: DECISION_STATUS[verb],
    source: "owner_" + verb,
    at: now,
    note: note || "",
    // Monotonic per-topic counter. The client echoes the revision it rendered
    // and the server rejects a mismatch, so a decision aimed at an older
    // record -- including a same-state-but-newer one, which the three-word
    // label alone cannot distinguish -- never lands. Also what makes repeat
    // sends detectable as "already applied" rather than "applied twice".
    revision: revision,
    schemaVersion: DISPOSITION_SCHEMA_VERSION,
  };
}

function dispositionRevision(topic) {
  var d = topic && topic.ownerDisposition;
  if (!d || typeof d !== "object") return 0;
  var revision = Number(d.revision);
  // Records minted before revisions existed count as revision 1: they are a
  // real first record, not the absence of one.
  if (!isFinite(revision) || revision < 1) return 1;
  return Math.floor(revision);
}

// Applies one explicit owner decision to one resolved topic. The caller has
// already done authority (owner-only), resolution and the stale-state check;
// this validates the verb, the revision precondition, and writes the durable
// record.
function applyOwnerDecision(topic, decision, deps) {
  var verb = String(decision && decision.verb || "");
  if (!DECISION_STATUS[verb]) return { ok: false, code: "unknown_decision" };
  if (!topic) return { ok: false, code: "topic_not_found" };
  var note = cleanNote(decision && decision.note);
  // "Not like this" without saying what is wrong tells the next reader
  // nothing; the note is the whole payload of a request_changes.
  if (verb === "request_changes" && !note) return { ok: false, code: "note_required" };
  var current = dispositionRevision(topic);
  if (decision && decision.expectedRevision != null) {
    var expected = Number(decision.expectedRevision);
    if (!isFinite(expected) || Math.floor(expected) !== current) {
      return { ok: false, code: "stale_disposition", currentRevision: current };
    }
  }
  var now = deps && typeof deps.now === "function" ? deps.now() : Date.now();
  topic.ownerDisposition = decisionRecord(verb, note, now, current + 1);
  topic.updatedAt = now;
  return { ok: true, disposition: topic.ownerDisposition };
}

function hasLinkedTask(topic, tasks) {
  var wanted = topicIdOf(topic && topic.topicRef);
  var list = Array.isArray(tasks) ? tasks : [];
  if (!wanted) return false;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && topicIdOf(list[i].coopTopicRef) === wanted) return true;
  }
  return false;
}

// One pass over the index. For every open topic:
//
//   linked   -- at least one orchestration task carries this topic's ref. No
//               disposition is written; the live task evidence IS the state.
//   defaulted-- no linked task and no existing disposition. The durable
//               "unlinked_historical" needs-input record is written: the owner
//               decides what this topic is, and until they do the row says so.
//   kept     -- an ownerDisposition already exists (a previous backfill or an
//               owner decision). Never overwritten: the backfill must not undo
//               an owner's explicit call, and repeat runs must be no-ops.
//
// Closed and merged topics are skipped: closed is already terminal Done
// evidence in coop-topic-state, and merged topics never project at all.
function backfillDispositions(index, deps) {
  var report = { linked: 0, defaulted: 0, kept: 0 };
  var topics = index && index.topics || {};
  var keys = Object.keys(topics);
  var now = deps && typeof deps.now === "function" ? deps.now() : Date.now();
  for (var i = 0; i < keys.length; i++) {
    var topic = topics[keys[i]];
    if (!topic || topic.status !== "open") continue;
    if (topic.ownerDisposition && typeof topic.ownerDisposition === "object") { report.kept++; continue; }
    if (hasLinkedTask(topic, deps && deps.tasks)) { report.linked++; continue; }
    topic.ownerDisposition = {
      status: "needs_input",
      source: "unlinked_historical",
      at: now,
      note: "",
      revision: 1,
      schemaVersion: DISPOSITION_SCHEMA_VERSION,
    };
    topic.updatedAt = now;
    report.defaulted++;
  }
  return report;
}

module.exports = {
  DISPOSITION_SCHEMA_VERSION: DISPOSITION_SCHEMA_VERSION,
  applyOwnerDecision: applyOwnerDecision,
  backfillDispositions: backfillDispositions,
  cleanNote: cleanNote,
  dispositionRevision: dispositionRevision,
};
