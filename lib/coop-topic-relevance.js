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
var lineage = require("./coop-topic-lineage");

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
  // An injected control prompt must not mint or populate a topic, and must not
  // drive Working / Needs input / Done, however conversational its text looks.
  if (!hasOwnerProvenance(turn)) return false;
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
  for (var i = 0; i < turnRefs.length; i++) {
    var ref = turnRefs[i] || {};
    var resolved = lineage.recordAt(history, ref.sessionStorageId || "", ref.startEventIndex);
    if (!resolved || !resolved.record) continue;
    if (!isInternalHistoryItem(resolved.record)) return true;
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
  // Derived from the owner's actual canonical transcript, not guessed. The
  // first version of this list guessed "tool_use"/"tool_call"/"thinking", none
  // of which this system emits, so 5,116 tool records classified as
  // conversation and Bash stayed visible in Main.
  tool_start: true, tool_executing: true, tool_result: true, mcp_tool_call: true,
  // Not emitted here, but other providers use these names; harmless to cover.
  tool_use: true, tool_call: true,
  // thinking_delta is emitted per token by sdk-message-processor.js:592 and was
  // missing here, so reasoning streamed into Main and consumed the bounded
  // replay window ahead of the owner's own question. The prefix guard below
  // catches any future thinking_* type rather than waiting to be bitten again.
  thinking: true, thinking_start: true, thinking_stop: true, thinking_delta: true,
  subagent_activity: true, subagent_done: true, subagent_tool: true,
  permission_request: true, permission_request_pending: true,
  permission_resolved: true, permission_denied: true, permission_cancel: true,
  context_usage: true, rate_limit_usage: true, rate_limit: true,
  model_info: true, model_verified: true, model_refusal: true,
  message_uuid: true, session_id: true, fast_mode_state: true, meta: true,
  orchestration_tasks_state: true, prompt_suggestion: true,
  sdk_notification: true, informational: true, compacting: true,
  system_info: true, plan_content: true, slash_command_result: true,
  digest_checkpoint: true,
  // The scheduled Lead tick surfaces as these before it becomes a message.
  scheduled_message_queued: true, scheduled_message_sent: true,
  scheduled_message_cancelled: true,
};

// The Lead procedure deliberately emits these exact authority statements. New
// events still have no typed `authorityDisclosure` provenance, including the
// persisted assistant deltas written by earlier builds. Main therefore uses
// this deliberately narrow compatibility fallback: exact contract sentences in
// assistant text events only. `user_message` is excluded by type, so an owner
// can quote, discuss, or complain about either sentence without disappearing.
var LEAD_AUTHORITY_DISCLOSURES = [
  "Lead mode is on: I can autonomously staff admitted, non-self-modification work within budget; self-modification, unadmitted approval-class work, and spend or budget exceptions require owner approval.",
  "Lead mode is off: I cannot staff work or authorize spend. I can still find, triage, or switch to sessions.",
];

var ASSISTANT_TEXT_EVENT_TYPES = {
  delta: true,
  delta_replace: true,
};

function removeLeadAuthorityDisclosures(text) {
  if (typeof text !== "string" || !text) return text;
  var projected = text;
  for (var i = 0; i < LEAD_AUTHORITY_DISCLOSURES.length; i++) {
    var disclosure = LEAD_AUTHORITY_DISCLOSURES[i];
    var found = projected.indexOf(disclosure);
    while (found !== -1) {
      var before = projected.slice(0, found);
      var after = projected.slice(found + disclosure.length);
      // Status lines are normally separated from the useful update by blank
      // lines. Keep one paragraph boundary instead of leaving a visibly empty
      // disclosure-sized gap in Main.
      if (/\n[ \t]*\n[ \t]*$/.test(before) && /^[ \t]*\n[ \t]*\n/.test(after)) {
        before = before.replace(/\n[ \t]*\n[ \t]*$/, "\n\n");
        after = after.replace(/^[ \t]*\n[ \t]*\n/, "");
      } else if (!before) {
        after = after.replace(/^[ \t]*\n[ \t]*/, "");
      } else if (!after) {
        before = before.replace(/\n[ \t]*\n[ \t]*$/, "");
      }
      projected = before + after;
      found = projected.indexOf(disclosure);
    }
  }
  return projected;
}

function isLeadAuthorityDisclosureRecord(item) {
  return !!(item && ASSISTANT_TEXT_EVENT_TYPES[item.type] &&
    typeof item.text === "string" &&
    removeLeadAuthorityDisclosures(item.text) !== item.text);
}

function isOnlyLeadAuthorityDisclosure(item) {
  return isLeadAuthorityDisclosureRecord(item) &&
    !removeLeadAuthorityDisclosures(item.text).trim();
}

// Replays need a stateful projector because providers may split the exact
// contract across several delta records. A replacement event corrects the
// already-rendered partial text once the full sentence is known, while normal
// assistant streaming remains byte-for-byte unchanged.
function createMainAuthorityDisclosureProjector() {
  var rawAssistantText = "";

  function reset() {
    rawAssistantText = "";
  }

  function project(item) {
    if (!item) return item;
    if (item.type === "user_message" || item.type === "done") {
      reset();
      return item;
    }
    if (!ASSISTANT_TEXT_EVENT_TYPES[item.type] || typeof item.text !== "string") return item;
    if (item.type === "delta_replace") rawAssistantText = item.text;
    else rawAssistantText += item.text;
    var projected = removeLeadAuthorityDisclosures(rawAssistantText);
    if (projected === rawAssistantText) return item;
    return Object.assign({}, item, { type: "delta_replace", text: projected });
  }

  return { project: project, reset: reset };
}

// Shape-based fallback, so a tool record is recognised even when its type name
// is one this build has never seen. Tool traffic is correlated by an execution
// id plus either the tool name or a result payload; that shape is durable in a
// way a type-name list can never be, and it is what protects transcripts
// written by older builds.
// Owner provenance. A message the owner actually typed always carries at least
// one durable marker of how it entered: the user id and display name the server
// stamps, the clientMessageId the composer generates, or a coopIngress* key from
// the Coop intake path.
//
// Injected control prompts carry NONE of them. Against the owner's real Coop
// transcripts that separates 250 genuine owner messages from 198 machine
// injections -- the scheduled "Lead tick", resume/continue markers, worker
// update envelopes, and compactedRetry re-injections -- WITHOUT matching any
// prose. That distinction matters: the owner's own message "why do I have lead
// tick every time I send you a message?" mentions the tick and must stay.
function hasOwnerProvenance(item) {
  if (!item || typeof item !== "object") return false;
  if (item.from || item.fromName || item.clientMessageId) return true;
  var keys = Object.keys(item);
  for (var i = 0; i < keys.length; i++) {
    // Presence is not enough: the turn record stamps these keys with empty
    // strings when absent, so an injected prompt would otherwise look like it
    // came through the owner intake path.
    if (keys[i].indexOf("coopIngress") === 0 && item[keys[i]]) return true;
  }
  return false;
}

// A user_message is the carrier every injected control prompt reuses, so it is
// the only type where absence of provenance is meaningful.
function isInjectedUserMessage(item) {
  if (!item || item.type !== "user_message") return false;
  return !hasOwnerProvenance(item);
}

function isToolShapedRecord(item) {
  if (!item || typeof item !== "object") return false;
  if (!item.id) return false;
  if (typeof item.name === "string" && item.name) return true;
  return Object.prototype.hasOwnProperty.call(item, "is_error") ||
    (Object.prototype.hasOwnProperty.call(item, "content") &&
      !Object.prototype.hasOwnProperty.call(item, "text"));
}

function isThinkingShaped(item) {
  var type = item && typeof item.type === "string" ? item.type : "";
  return type.indexOf("thinking") === 0;
}

function isOperationalEvent(item) {
  if (!item) return false;
  if (OPERATIONAL_EVENT_TYPES[item.type]) return true;
  if (isThinkingShaped(item)) return true;
  if (isInjectedUserMessage(item)) return true;
  return isToolShapedRecord(item);
}

// Canonical history indexes that belong in the Main lens: everything the owner
// would recognise as the conversation, in canonical order. Bare `info` is
// excluded too -- it is the bucket every provider/routing/recovery notice lands
// in -- while genuine questions and blockers keep their own types and stay.
// The single definition of "the owner would recognise this as the conversation".
// Main and every topic lens MUST share it: a topic lens is a filter over the
// same owner conversation, not a raw replay of a turn span. They were separate
// before, so Main was clean while topic chats still replayed ticks, tool
// traffic and control envelopes from inside the same spans.
function isOwnerRelevantRecord(item) {
  if (isInternalHistoryItem(item)) return false;
  if (isOperationalEvent(item)) return false;
  // Bare `info` is the bucket every provider/routing/recovery notice lands in.
  if (item && item.type === "info") return false;
  return true;
}

// Lead ticks are persisted as ordinary user_message -> assistant-event turns,
// but the opener is the only record that carries the automation provenance.
// Keep the turn state while filtering so the assistant's internal commentary
// does not become owner conversation merely because it follows an internal
// opener. The first distinct progress text is useful as a milestone; unchanged
// copies from later ticks are operational noise.
var INTERNAL_PROGRESS_TYPES = {
  delta: true,
  delta_replace: true,
  plan_content: true,
  result: true,
};

var OWNER_ACTION_TYPES = {
  ask_user: true,
  needs_input: true,
  error: true,
  auth_required: true,
  elicitation: true,
  user_dialog: true,
};

function isInternalTurnOpener(item) {
  return !!(item && item.type === "user_message" &&
    (isInternalHistoryItem(item) || isInjectedUserMessage(item)));
}

function progressTextKey(item) {
  if (!item || !INTERNAL_PROGRESS_TYPES[item.type] || typeof item.text !== "string") return "";
  var text = item.text.trim().replace(/\s+/g, " ");
  return text ? "progress:" + text : "";
}

function historyOwnerRelevantIndexes(history, options) {
  var items = Array.isArray(history) ? history : [];
  var opts = options || {};
  var preserve = opts.preserveIndexes && typeof opts.preserveIndexes === "object"
    ? opts.preserveIndexes : {};
  var kept = [];
  var internalTurn = false;
  var seenProgress = Object.create(null);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item && item.type === "user_message") {
      internalTurn = isInternalTurnOpener(item);
    }
    if (internalTurn) {
      // A typed owner-decision response has explicit durable provenance. It is
      // not routine tick chatter, so an earlier identical progress sentence
      // must not suppress this distinct owner-facing turn.
      if (preserve[i] && INTERNAL_PROGRESS_TYPES[item && item.type]) {
        kept.push(i);
        continue;
      }
      if (OWNER_ACTION_TYPES[item && item.type]) {
        kept.push(i);
        continue;
      }
      var key = progressTextKey(item);
      if (key && !seenProgress[key]) {
        seenProgress[key] = true;
        kept.push(i);
      }
      continue;
    }
    if (isOwnerRelevantRecord(item) &&
        !(opts.suppressLeadAuthorityDisclosures && isOnlyLeadAuthorityDisclosure(item))) kept.push(i);
  }
  return kept;
}

// Narrows an existing index list to the owner-relevant subset, preserving order
// and never inventing an index the caller did not already admit.
function ownerRelevantIndexes(history, indexes, options) {
  var items = Array.isArray(history) ? history : [];
  var source = Array.isArray(indexes) ? indexes : [];
  var relevant = historyOwnerRelevantIndexes(items, options);
  var relevantByIndex = Object.create(null);
  for (var r = 0; r < relevant.length; r++) relevantByIndex[relevant[r]] = true;
  var kept = [];
  for (var i = 0; i < source.length; i++) {
    var index = source[i];
    if (!Number.isInteger(index) || index < 0 || index >= items.length) continue;
    if (relevantByIndex[index]) kept.push(index);
  }
  return kept;
}

function mainLensEventIndexes(history) {
  return historyOwnerRelevantIndexes(history, { suppressLeadAuthorityDisclosures: true });
}

module.exports = {
  hasOwnerProvenance: hasOwnerProvenance,
  isOwnerRelevantRecord: isOwnerRelevantRecord,
  ownerRelevantIndexes: ownerRelevantIndexes,
  INTERNAL_PROGRESS_TYPES: INTERNAL_PROGRESS_TYPES,
  isInjectedUserMessage: isInjectedUserMessage,
  INTERNAL_ORIGINS: INTERNAL_ORIGINS,
  OPERATIONAL_EVENT_TYPES: OPERATIONAL_EVENT_TYPES,
  LEAD_AUTHORITY_DISCLOSURES: LEAD_AUTHORITY_DISCLOSURES,
  isInternalHistoryItem: isInternalHistoryItem,
  isOperationalEvent: isOperationalEvent,
  isToolShapedRecord: isToolShapedRecord,
  isLeadAuthorityDisclosureRecord: isLeadAuthorityDisclosureRecord,
  isOnlyLeadAuthorityDisclosure: isOnlyLeadAuthorityDisclosure,
  removeLeadAuthorityDisclosures: removeLeadAuthorityDisclosures,
  createMainAuthorityDisclosureProjector: createMainAuthorityDisclosureProjector,
  isOwnerRelevantTurn: isOwnerRelevantTurn,
  topicHasRelevantTurn: topicHasRelevantTurn,
  mainLensEventIndexes: mainLensEventIndexes,
};
