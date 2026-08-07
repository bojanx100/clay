// Conventional Close action for one Coop topic, behind an explicit confirmation.
//
// Closing is a durable state change on the shared topic index, so it never
// happens on a single click. Cancelling is a strict no-op: no message is sent
// and no local state changes. Confirming sends exactly one close request, even
// if the confirm control is activated more than once, because the pending
// request is latched before the transport is called.

import { showConfirm } from './confirm-modal.js';
import { buildCoopTopicActionMessage } from './sidebar-coop-topic-model.js';
import { findGlobalCoopTopic } from './global-coop-projection.js';
import { canonicalTopicTitle } from './coop-identity.js';

function confirmationText(topic) {
  // Same canonical naming as the row the owner tapped, so a row shown as
  // "Untitled topic" cannot reveal an "auto-<hex>" key in the confirmation.
  var title = topic ? canonicalTopicTitle(topic, "") : "this topic";
  return "Close “" + title + "”? It stops appearing in the topic list. " +
    "The canonical conversation is not deleted.";
}

// The transport arrives through `options.send` rather than a direct import of
// app-connection, so this module stays independent of the app's connection graph
// and remains testable on its own. `options.confirm` overrides the app modal.
export function requestTopicClose(topic, options) {
  var opts = options || {};
  var confirm = typeof opts.confirm === "function" ? opts.confirm : showConfirm;
  var send = typeof opts.send === "function" ? opts.send : null;
  if (!send) return false;
  // Resolve against the live projection so a topic that vanished, or that the
  // actor may no longer see, cannot be closed from a stale row.
  var known = topic && findGlobalCoopTopic(topic.topicRef, topic.projectRef);
  if (!known) return false;
  var settled = false;
  confirm(confirmationText(known), function () {
    if (settled) return;
    settled = true;
    // Re-resolve on confirm. The projection can change while the modal is open:
    // if the topic was merged or access was revoked in the meantime, closing the
    // captured copy would resurrect it as a closed topic.
    var current = findGlobalCoopTopic(known.topicRef, known.projectRef);
    if (!current) return;
    var payload = buildCoopTopicActionMessage("close", current, null);
    if (payload) send(payload);
  }, "Close topic", false, "Cancel");
  return true;
}

export function createTopicCloseButton(topic, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var button = document.createElement("button");
  button.type = "button";
  button.className = prefix + "coop-topic-close";
  button.textContent = "Close";
  button.setAttribute("aria-label", "Close topic " + (topic && topic.title || "topic"));
  button.addEventListener("click", function (event) {
    // The row itself navigates; closing must not also switch the lens.
    event.stopPropagation();
    requestTopicClose(topic, opts);
  });
  return button;
}
