// Owner-relevance for canonical Coop turns.
//
// One predicate, shared by three consumers so they cannot drift:
//   * topic admission   -- internal-only activity must not mint a topic;
//   * topic projection  -- a topic with no relevant turn is not shown;
//   * the Main lens     -- the default owner-facing replay scope.
//
// Relevance is decided from durable flags the writer already sets, never from
// message text. `internalOnly` predates this module: project-task-orchestrator
// stamps it on worker-notification turns, sessions-loader re-derives it on load,
// and sessions-history already drops those turns from replay. The bug this
// module fixes is that classification never consulted them, so a turn that is
// invisible in the transcript could still create and populate a topic -- which
// is how an empty topic lens becomes possible.

// Synthetic origins that are Coop talking to itself rather than to the owner.
// `task-notification` is the worker fan-in; `automation` covers the scheduled
// Lead tick, whose displayed text is a label rather than something the owner
// typed.
var INTERNAL_ORIGINS = {
  "task-notification": true,
  "automation": true,
  "lead-tick": true,
};

function originKind(record) {
  var origin = record && record.origin;
  if (!origin) return "";
  return String(origin.kind || origin.type || "");
}

// A single canonical history record.
function isInternalHistoryItem(item) {
  if (!item) return true;
  if (item.internalOnly === true) return true;
  if (item._internal === true) return true;
  if (item.type === "digest_checkpoint") return true;
  if (item.autoAction === true) return true;
  if (item.synthetic === true && INTERNAL_ORIGINS[originKind(item)]) return true;
  return false;
}

// A turn as produced by coop-topic-extraction.completeTurns. The turn carries
// the flags of the `user_message` that opened it, so an internal opener makes
// the whole turn internal: Coop answering its own automation is not owner
// conversation either.
function isOwnerRelevantTurn(turn) {
  if (!turn) return false;
  if (turn.internalOnly === true) return false;
  if (turn.autoAction === true) return false;
  if (turn.synthetic === true && INTERNAL_ORIGINS[originKind(turn)]) return false;
  // A turn with no owner text and no assistant answer carries nothing to read.
  var userText = typeof turn.userText === "string" ? turn.userText.trim() : "";
  var answer = typeof turn.finalText === "string" && turn.finalText.trim()
    ? turn.finalText.trim()
    : (typeof turn.deltaText === "string" ? turn.deltaText.trim() : "");
  return !!(userText || answer);
}

// Does this topic have at least one owner-relevant turn? Used to decide whether
// the topic is shown at all. Membership is expressed as canonical turn spans, so
// this resolves each span back to its opening history record.
function topicHasRelevantTurn(topic, history) {
  if (!topic) return false;
  var turnRefs = Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
  var items = Array.isArray(history) ? history : [];
  for (var i = 0; i < turnRefs.length; i++) {
    var ref = turnRefs[i] || {};
    var start = ref.startEventIndex;
    if (typeof start !== "number" || start < 0 || start >= items.length) continue;
    if (!isInternalHistoryItem(items[start])) return true;
  }
  return false;
}

// Execution narration: the how, not the what. These are the event types the
// owner does not read as conversation -- tool traffic, thinking, subagent
// chatter, permission plumbing, provider/routing/binding notices, usage and
// model telemetry.
//
// Deliberately a DENYLIST, not an allowlist. A new operational event type
// leaking into Main is a visible annoyance the owner can report; a new
// conversational type silently vanishing from Main is lost content the owner
// may never discover. All remains the full-fidelity escape hatch either way.
var OPERATIONAL_EVENT_TYPES = {
  tool_use: true, tool_call: true, tool_result: true, mcp_tool_call: true,
  thinking: true,
  subagent_activity: true, subagent_done: true, subagent_tool: true,
  permission_request: true, permission_request_pending: true,
  permission_resolved: true, permission_denied: true, permission_cancel: true,
  context_usage: true, rate_limit_usage: true, rate_limit: true,
  model_info: true, model_verified: true, model_refusal: true,
  message_uuid: true, session_id: true, fast_mode_state: true,
  orchestration_tasks_state: true, prompt_suggestion: true,
  sdk_notification: true, informational: true, compacting: true,
  plan_content: true, slash_command_result: true,
  digest_checkpoint: true,
};

function isOperationalEvent(item) {
  return !!(item && OPERATIONAL_EVENT_TYPES[item.type]);
}

// Canonical history indexes that belong in the Main lens: everything the owner
// would recognise as the conversation, in canonical order. Bare `info` is
// excluded too -- it is the bucket every provider/routing/recovery notice lands
// in -- while genuine questions and blockers keep their own types and stay.
function mainLensEventIndexes(history) {
  var items = Array.isArray(history) ? history : [];
  var indexes = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (isInternalHistoryItem(item)) continue;
    if (isOperationalEvent(item)) continue;
    if (item && item.type === "info") continue;
    indexes.push(i);
  }
  return indexes;
}

module.exports = {
  INTERNAL_ORIGINS: INTERNAL_ORIGINS,
  OPERATIONAL_EVENT_TYPES: OPERATIONAL_EVENT_TYPES,
  isInternalHistoryItem: isInternalHistoryItem,
  isOperationalEvent: isOperationalEvent,
  isOwnerRelevantTurn: isOwnerRelevantTurn,
  topicHasRelevantTurn: topicHasRelevantTurn,
  mainLensEventIndexes: mainLensEventIndexes,
};
