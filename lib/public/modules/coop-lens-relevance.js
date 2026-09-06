// coop-lens-relevance.js - Live per-block lens classification.
//
// Main is a server replay scope, so a lens SELECTION and a RECONNECT already
// arrive filtered. Live streaming does not go through replay: during an active
// turn the server pushes every event to every viewer, so without this the
// owner's default view would be clean on entry and fill with execution
// narration as Coop worked. Main has to be continuously owner-relevant, not
// eventually.
//
// Each block is classified once, as it is created, and marked on the element.
// The lens then decides what is shown. Classification deliberately does NOT
// remove or reorder anything:
//
//   * addToMessages stamps clayTs / historyIndex and re-pins the scheduled
//     bubble, pre-thinking dots and activity indicator to the bottom;
//   * renderVendorSwitchDivider walks messagesEl.children comparing clayTs to
//     insert itself in timestamp order;
//   * shouldGroupMessage reads lastElementChild to group consecutive messages;
//   * prependOlderHistory renumbers every [data-turn] across the container;
//   * app-cursors queries [data-turn] for presence highlighting.
//
// All five assume #messages children are a flat, ordered list. Dropping blocks
// on the live path, or wrapping them, would break ordering, grouping and
// pagination in ways that only show up after scrolling back. Marking and
// filtering preserves the flat live transcript. Lens selection requests a
// fresh server replay; its history_done restores the active turn's relevance.
//
// The event-type vocabulary mirrors lib/coop-topic-relevance.js so the live
// path and the replay path cannot disagree about what "internal" means.

export var RELEVANCE_OWNER = "owner";
export var RELEVANCE_INTERNAL = "internal";

// Execution narration: the how, not the what.
var OPERATIONAL_EVENT_TYPES = {
  // Derived from the owner's actual canonical transcript, not guessed. The
  // first version of this list guessed "tool_use"/"tool_call"/"thinking", none
  // of which this system emits, so 5,116 tool records classified as
  // conversation and Bash stayed visible in Main.
  tool_start: true, tool_executing: true, tool_result: true, mcp_tool_call: true,
  tool_output: true, task_started: true, task_progress: true, task_updated: true,
  coop_owner_response_started: true, coop_owner_decision_staged: true,
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
  // Provider/routing/binding narration all arrives as bare `info`.
  info: true,
};

function originKind(message) {
  var origin = message && message.origin;
  if (!origin) return "";
  return String(origin.kind || origin.type || "");
}

var INTERNAL_ORIGINS = {
  "task-notification": true,
  "automation": true,
  "lead-tick": true,
};

// This exactly mirrors lib/coop-topic-relevance.js. Assistant deltas persisted
// by current and historical providers have no typed authority-disclosure field,
// so the Main projection has one narrow compatibility fallback. It never
// touches a user_message, preserving owner quotes and discussion of the same
// contract words.
export var LEAD_AUTHORITY_DISCLOSURES = [
  "Lead mode is on: I can autonomously staff admitted, non-self-modification work within budget; self-modification, unadmitted approval-class work, and spend or budget exceptions require owner approval.",
  "Lead mode is off: I cannot staff work or authorize spend. I can still find, triage, or switch to sessions.",
];

var ASSISTANT_TEXT_EVENT_TYPES = {
  delta: true,
  delta_replace: true,
};

export function removeLeadAuthorityDisclosures(text) {
  if (typeof text !== "string" || !text) return text;
  var projected = text;
  for (var i = 0; i < LEAD_AUTHORITY_DISCLOSURES.length; i++) {
    var disclosure = LEAD_AUTHORITY_DISCLOSURES[i];
    var found = projected.indexOf(disclosure);
    while (found !== -1) {
      var before = projected.slice(0, found);
      var after = projected.slice(found + disclosure.length);
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

// A fenced execution example remains available in All. Retain Mermaid, which
// the message renderer turns into a diagram, and leave owner messages intact.
function conversationText(text) {
  var lines = String(text || "").match(/[^\n]*\n|[^\n]+$/g) || [];
  var kept = "";
  var fence = "";
  var visual = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var match = line.match(/^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})([^\n]*)(?:\n|$)$/);
    if (fence) {
      if (visual) kept += line;
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
        fence = "";
        visual = false;
      }
      continue;
    }
    if (match) {
      fence = match[1];
      visual = match[2].trim().toLowerCase() === "mermaid";
      if (visual && line.endsWith("\n")) kept += line;
      continue;
    }
    // A fence can arrive one character at a time. Hold a possible opening
    // delimiter until the line disambiguates it, before any code can render.
    if (!line.endsWith("\n") && /^[ \t]*(?:>[ \t]*)*(?:`{1,2}|~{1,2})$/.test(line)) continue;
    kept += line;
  }
  return kept;
}

function pendingLeadAuthorityDisclosurePrefix(text) {
  if (typeof text !== "string" || !text) return "";
  var pending = "";
  for (var i = 0; i < LEAD_AUTHORITY_DISCLOSURES.length; i++) {
    var disclosure = LEAD_AUTHORITY_DISCLOSURES[i];
    var max = Math.min(disclosure.length - 1, text.length);
    for (var length = max; length > pending.length; length--) {
      if (text.slice(-length) === disclosure.slice(0, length)) {
        pending = disclosure.slice(0, length);
        break;
      }
    }
  }
  return pending;
}

export function createMainAuthorityDisclosureProjector() {
  var rawAssistantText = "";
  var projectedAssistantText = "";
  var projecting = false;

  function reset() {
    rawAssistantText = "";
    projectedAssistantText = "";
    projecting = false;
  }

  function project(message) {
    if (!message) return message;
    if (message.type === "coop_owner_update") return Object.assign({}, message, {
      text: conversationText(removeLeadAuthorityDisclosures(message.text)),
    });
    if (message.type === "user_message" || message.type === "done" ||
        message.type === "coop_owner_response_started" || message.type === "coop_owner_decision_staged" ||
        message.type === "coop_internal_turn_started") {
      reset();
      return message;
    }
    if (!ASSISTANT_TEXT_EVENT_TYPES[message.type] || typeof message.text !== "string") return message;
    if (message.type === "delta_replace") rawAssistantText = message.text;
    else rawAssistantText += message.text;
    var projected = conversationText(removeLeadAuthorityDisclosures(rawAssistantText));
    var pending = pendingLeadAuthorityDisclosurePrefix(projected);
    if (pending) projected = projected.slice(0, -pending.length);
    if (projected !== rawAssistantText) projecting = true;
    if (!projecting) {
      projectedAssistantText = projected;
      return message;
    }
    var growsFromVisibleText = projected.slice(0, projectedAssistantText.length) ===
      projectedAssistantText;
    var type = growsFromVisibleText ? "delta" : "delta_replace";
    var text = growsFromVisibleText ? projected.slice(projectedAssistantText.length) : projected;
    projectedAssistantText = projected;
    if (message.type === type && message.text === text) return message;
    return Object.assign({}, message, { type: type, text: text });
  }

  return { project: project, reset: reset };
}

// Decided from durable flags the server already sets, never from message text.
// The scheduled Lead tick reaches the client as an ordinary user_message whose
// text is a label; `autoAction` is what distinguishes it from something the
// owner typed, so matching the label text would rot the moment it changes.
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
export function hasOwnerProvenance(message) {
  if (!message || typeof message !== "object") return false;
  if (message.from || message.fromName || message.clientMessageId) return true;
  var keys = Object.keys(message);
  for (var i = 0; i < keys.length; i++) {
    // Presence is not enough: the turn record stamps these keys with empty
    // strings when absent, so an injected prompt would otherwise look like it
    // came through the owner intake path.
    if (keys[i].indexOf("coopIngress") === 0 && message[keys[i]]) return true;
  }
  return false;
}

export function isInjectedUserMessage(message) {
  if (!message || message.type !== "user_message") return false;
  return !hasOwnerProvenance(message);
}

export function isToolShapedMessage(item) {
  if (!item || typeof item !== "object") return false;
  if (!item.id) return false;
  if (typeof item.name === "string" && item.name) return true;
  return Object.prototype.hasOwnProperty.call(item, "is_error") ||
    (Object.prototype.hasOwnProperty.call(item, "content") &&
      !Object.prototype.hasOwnProperty.call(item, "text"));
}

function isThinkingShaped(message) {
  var type = message && typeof message.type === "string" ? message.type : "";
  return type.indexOf("thinking") === 0;
}

export function messageRelevance(message) {
  if (!message) return RELEVANCE_INTERNAL;
  if (message.internalOnly === true) return RELEVANCE_INTERNAL;
  if (message._internal === true) return RELEVANCE_INTERNAL;
  if (message.autoAction === true) return RELEVANCE_INTERNAL;
  if (message.synthetic === true && INTERNAL_ORIGINS[originKind(message)]) return RELEVANCE_INTERNAL;
  // Denylist, not allowlist: a new operational type leaking into Main is a
  // visible annoyance the owner can report, while a new conversational type
  // silently disappearing is content they would never discover missing.
  if (OPERATIONAL_EVENT_TYPES[message.type]) return RELEVANCE_INTERNAL;
  if (isThinkingShaped(message)) return RELEVANCE_INTERNAL;
  if (isInjectedUserMessage(message)) return RELEVANCE_INTERNAL;
  if (isToolShapedMessage(message)) return RELEVANCE_INTERNAL;
  return RELEVANCE_OWNER;
}

var OWNER_ACTION_TYPES = {
  ask_user: true,
  needs_input: true,
  error: true,
  auth_required: true,
  elicitation: true,
  elicitation_request: true,
  user_dialog: true,
  user_dialog_request: true,
};

// Automated prose is internal until a typed owner-response signal. Published
// reports are standalone records and never reveal the rest of the tick.
export function createTurnRelevanceTracker() {
  var internalTurn = false;
  var ownerResponse = false;

  function reset() {
    internalTurn = false;
    ownerResponse = false;
  }

  function relevance(message) {
    if (message && message.type === "history_done" && message.coopConversationState) {
      internalTurn = message.coopConversationState.internalTurn === true;
      ownerResponse = message.coopConversationState.ownerResponse === true;
    }
    if (message && message.type === "coop_internal_turn_started") {
      internalTurn = true; ownerResponse = false; return RELEVANCE_INTERNAL;
    }
    if (message && message.type === "user_message" && message.compactedRetry !== true) {
      internalTurn = messageRelevance(message) === RELEVANCE_INTERNAL;
      ownerResponse = false;
    }
    if (message && (message.type === "coop_owner_decision_staged" ||
        message.type === "coop_owner_response_started")) {
      ownerResponse = true;
      return RELEVANCE_INTERNAL;
    }
    if (!internalTurn || ownerResponse) return messageRelevance(message);
    if (message && message.type === "coop_owner_update") return RELEVANCE_OWNER;
    if (OWNER_ACTION_TYPES[message && message.type]) return RELEVANCE_OWNER;
    return RELEVANCE_INTERNAL;
  }

  return { relevance: relevance, reset: reset };
}

export function isInternalMessage(message) {
  return messageRelevance(message) === RELEVANCE_INTERNAL;
}
