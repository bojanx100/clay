// Captures the owner-visible Coop lens as one immutable send-time destination.

import { store } from './store.js';
import { getActiveCoopIngressRefs, isActiveCoopTopicStale } from './global-coop-projection.js';

var VALID_SCOPES = {
  canonical: true,
  main: true,
  project: true,
  topic: true,
};
var hasOwn = Object.prototype.hasOwnProperty;

function cloneRef(ref) {
  if (!ref || typeof ref !== 'object') return null;
  try { return JSON.parse(JSON.stringify(ref)); } catch (e) { return null; }
}

export function captureCoopComposerScope() {
  if (!store.get('activeCoopHome')) return null;

  // The explicit lens marker is authoritative. It is set when a selection is
  // committed and deliberately wins over any stale refs that a reconnect or
  // delayed UI update has not cleared yet.
  var scope = store.get('activeCoopLensScope');
  if (scope === 'main' || scope === 'canonical') {
    return { stale: false, scope: scope, topicRef: null, projectRef: null };
  }
  if (isActiveCoopTopicStale()) return { stale: true, scope: null, topicRef: null, projectRef: null };
  if (!hasOwn.call(VALID_SCOPES, scope)) {
    var refs = getActiveCoopIngressRefs();
    scope = refs && refs.topicRef ? 'topic' : (refs && refs.projectRef ? 'project' : 'canonical');
  }
  if (scope === 'main' || scope === 'canonical') {
    return { stale: false, scope: scope, topicRef: null, projectRef: null };
  }

  var routing = getActiveCoopIngressRefs();
  if (!routing || (scope === 'topic' && !routing.topicRef) ||
      (scope === 'project' && !routing.projectRef)) {
    return { stale: true, scope: scope, topicRef: null, projectRef: null };
  }
  return {
    stale: false,
    scope: scope,
    topicRef: cloneRef(routing.topicRef),
    projectRef: cloneRef(routing.projectRef),
  };
}
