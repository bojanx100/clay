// Lifecycle actions for one Coop topic, behind a compact overflow menu.
//
// Closing is a durable state change on the shared topic index, so it never
// happens on a single click. Cancelling is a strict no-op: no message is sent
// and no local state changes. Confirming sends exactly one close request, even
// if the confirm control is activated more than once, because the pending
// request is latched before the transport is called.

import { buildThreadControlMessage, openThreadCloseDialog } from './coop-thread-controls.js';
import { findGlobalCoopTopic } from './global-coop-projection.js';
import { canonicalTopicTitle } from './coop-identity.js';

// The transport arrives through `options.send` rather than a direct import of
// app-connection, so this module stays independent of the app's connection graph
// and remains testable on its own. `options.confirm` overrides the app modal.
export function requestTopicClose(topic, options) {
  var opts = options || {};
  var send = typeof opts.send === "function" ? opts.send : null;
  if (!send) return false;
  // Resolve against the live projection so a topic that vanished, or that the
  // actor may no longer see, cannot be closed from a stale row.
  var known = topic && findGlobalCoopTopic(topic.topicRef, topic.projectRef);
  if (!known) return false;
  openThreadCloseDialog(known, function (message) {
    var current = findGlobalCoopTopic(known.topicRef, known.projectRef);
    return current ? send(message) : false;
  }, null);
  return true;
}

// Reopening is the inverse action and needs no confirmation: it restores the
// topic to its open section and loses nothing. Resolved against the live
// projection like close, so a stale row cannot reopen a merged topic.
export function requestTopicReopen(topic, options) {
  var opts = options || {};
  var send = typeof opts.send === "function" ? opts.send : null;
  if (!send) return false;
  var current = topic && findGlobalCoopTopic(topic.topicRef, topic.projectRef);
  if (!current) return false;
  var payload = buildThreadControlMessage("state", current, { state: "exploring" });
  if (!payload) return false;
  send(payload);
  return true;
}

// The lifecycle action lives behind one compact overflow control instead of a
// text button repeated on every row. Each row offers exactly the action that is
// actually available to it -- Close for an open topic (still behind the explicit
// confirmation), Reopen for a closed one -- inside a real menu with keyboard
// behaviour: Escape closes and returns focus to the toggle, and focus leaving
// the control closes it. Open state is local to the DOM on purpose: a repaint
// from fresh projection data collapses the menu, which is the safe default.
export function createTopicMenu(topic, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var closed = !!(topic && (topic.threadState === "closed" || topic.status === "closed"));
  var title = topic ? canonicalTopicTitle(topic, "Thread") : "Thread";
  var ref = topic && topic.topicRef || {};
  var menuId = prefix + "coop-topic-menu-" +
    String(ref.topicId || ref.topicKey || ref.id || ref.key || "").replace(/[^a-zA-Z0-9_-]/g, "-");

  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-topic-menu";

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = prefix + "coop-topic-menu-toggle";
  toggle.textContent = "⋯";
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", menuId);
  toggle.setAttribute("aria-label", "Thread options for " + title);

  // The controlled menu stays in the DOM while collapsed (hidden, not
  // omitted) so aria-controls always resolves to a real element.
  var list = document.createElement("div");
  list.className = prefix + "coop-topic-menu-list";
  list.id = menuId;
  list.setAttribute("role", "menu");
  list.setAttribute("aria-label", "Thread options for " + title);
  list.hidden = true;

  function setOpen(open) {
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) wrapper.classList.add("open");
    else wrapper.className = wrapper.className.split(/\s+/).filter(function (name) {
      return name && name !== "open";
    }).join(" ");
  }

  var item = document.createElement("button");
  item.type = "button";
  item.className = prefix + "coop-topic-menu-item " + prefix +
    (closed ? "coop-topic-reopen" : "coop-topic-close");
  item.setAttribute("role", "menuitem");
  // Close still routes through the explicit confirmation; the ellipsis is the
  // conventional signal that activating it opens a dialog rather than acting.
  item.textContent = closed ? "Reopen Thread" : "Close Thread…";
  item.setAttribute("aria-label", (closed ? "Reopen Thread " : "Close Thread ") + title);
  item.addEventListener("click", function (event) {
    // The row itself navigates; the lifecycle action must not switch the lens.
    event.stopPropagation();
    setOpen(false);
    if (closed) requestTopicReopen(topic, opts);
    else requestTopicClose(topic, opts);
  });
  list.appendChild(item);

  toggle.addEventListener("click", function (event) {
    event.stopPropagation();
    var opening = list.hidden;
    setOpen(opening);
    if (opening && typeof item.focus === "function") item.focus();
  });
  wrapper.addEventListener("keydown", function (event) {
    if (!event || event.key !== "Escape" || list.hidden) return;
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    setOpen(false);
    if (typeof toggle.focus === "function") toggle.focus();
  });
  wrapper.addEventListener("focusout", function (event) {
    // Focus moving anywhere outside the control dismisses the menu, so an
    // abandoned menu never lingers over neighbouring rows.
    var next = event && event.relatedTarget;
    if (next && typeof wrapper.contains === "function" && wrapper.contains(next)) return;
    setOpen(false);
  });

  wrapper.appendChild(toggle);
  wrapper.appendChild(list);
  return wrapper;
}
