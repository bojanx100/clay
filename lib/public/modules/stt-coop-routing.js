// Captures the exact server-backed Coop destination when voice recording starts.

import { captureCoopComposerScope } from './coop-composer-scope.js';

var capturedRouting = null;

function cloneRef(ref) {
  if (!ref || typeof ref !== "object") return null;
  try { return JSON.parse(JSON.stringify(ref)); } catch (e) { return null; }
}

function cloneRouting(routing) {
  if (!routing) return null;
  return {
    stale: !!routing.stale,
    scope: typeof routing.scope === 'string' ? routing.scope : null,
    topicRef: cloneRef(routing.topicRef),
    projectRef: cloneRef(routing.projectRef),
  };
}

export function captureSTTCoopRouting() {
  var active = captureCoopComposerScope();
  capturedRouting = active ? cloneRouting(active) : {
    stale: false, scope: null, topicRef: null, projectRef: null,
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
