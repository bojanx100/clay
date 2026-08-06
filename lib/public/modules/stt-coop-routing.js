// Captures the exact server-backed Coop destination when voice recording starts.

import { getActiveCoopIngressRefs, isActiveCoopTopicStale } from './global-coop-projection.js';

var capturedRouting = null;

function cloneRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  try { return JSON.parse(JSON.stringify(ref)); } catch (e) { return null; }
}

function cloneRouting(routing) {
  if (!routing) return null;
  return {
    stale: !!routing.stale,
    topicRef: cloneRef(routing.topicRef),
    projectRef: cloneRef(routing.projectRef),
  };
}

export function captureSTTCoopRouting() {
  if (isActiveCoopTopicStale()) {
    capturedRouting = { stale: true, topicRef: null, projectRef: null };
    return cloneRouting(capturedRouting);
  }
  var active = getActiveCoopIngressRefs();
  capturedRouting = {
    stale: false,
    topicRef: cloneRef(active && active.topicRef),
    projectRef: cloneRef(active && active.projectRef),
  };
  return cloneRouting(capturedRouting);
}

export function takeSTTCoopRouting() {
  var routing = cloneRouting(capturedRouting);
  capturedRouting = null;
  return routing;
}

export function clearSTTCoopRouting() {
  capturedRouting = null;
}
