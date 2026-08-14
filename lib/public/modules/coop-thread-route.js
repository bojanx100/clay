// Shows the durable Thread selected for an owner turn, including automatic
// routing. The chip contains only a bounded title and a reference in data.

import { findGlobalCoopTopic } from './global-coop-projection.js';
import { canonicalTopicTitle } from './coop-identity.js';

function threadIdOf(msg) {
  var ref = msg && (msg.coopThreadRef || msg.threadRef || msg.coopTopicRef || msg.topicRef);
  return String(ref && (ref.threadId || ref.topicId) || "").trim();
}

export function applyCoopThreadRoute(el, msg) {
  var threadId = threadIdOf(msg);
  if (!el || !threadId || el.querySelector(".coop-thread-route")) return false;
  var topic = findGlobalCoopTopic({ topicId: threadId });
  var snapshot = msg && typeof msg.coopThreadTitle === "string" ? msg.coopThreadTitle : "";
  var title = canonicalTopicTitle(topic, snapshot, threadId);
  if (!title) title = "Selected Thread";
  var chip = document.createElement("span");
  chip.className = "coop-thread-route";
  chip.dataset.threadId = threadId;
  chip.textContent = "Thread: " + title;
  chip.setAttribute("aria-label", "Routed to Thread " + title);
  el.insertBefore(chip, el.firstChild || null);
  return true;
}
