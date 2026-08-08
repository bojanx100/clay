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
// filtering keeps the transcript structurally identical in every lens, which
// also means switching Main <-> All is instant and cannot duplicate or lose a
// block: the same DOM is simply revealed or hidden.
//
// The event-type vocabulary mirrors lib/coop-topic-relevance.js so the live
// path and the replay path cannot disagree about what "internal" means.

export var RELEVANCE_OWNER = "owner";
export var RELEVANCE_INTERNAL = "internal";

// Execution narration: the how, not the what.
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

// Decided from durable flags the server already sets, never from message text.
// The scheduled Lead tick reaches the client as an ordinary user_message whose
// text is a label; `autoAction` is what distinguishes it from something the
// owner typed, so matching the label text would rot the moment it changes.
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
  return RELEVANCE_OWNER;
}

export function isInternalMessage(message) {
  return messageRelevance(message) === RELEVANCE_INTERNAL;
}
