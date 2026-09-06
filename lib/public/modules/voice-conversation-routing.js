// Capture the destination before opening the microphone. A session or Lead
// change invalidates it; a later Coop lens never retargets recorded speech.
import { store } from './store.js';
import { captureCoopComposerScope } from './coop-composer-scope.js';

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

export function isSafeVoiceConversationRouting(route) {
  if (!route || route.stale || !route.projectSlug || !route.sessionId) return false;
  if (!route.canonicalCoop) return route.scope === "session" && route.projectSlug !== "lead";
  if (route.projectSlug !== "lead") return false;
  if (route.scope === "topic") return !!(route.topicRef && route.topicRef.topicId);
  if (route.scope === "project") return !!(route.projectRef && route.projectRef.projectId);
  return (route.scope === "main" || route.scope === "canonical") && !route.topicRef && !route.projectRef;
}

export function captureVoiceConversationRouting() {
  var s = store.snap();
  if (s.dmMode || s.activeSessionMode === "tui" || !s.activeSessionId ||
      s.activeSessionProjectSlug !== s.currentSlug) return null;
  var coop = s.leadModeEnabled === true;
  if (coop && (!s.activeCoopHome || s.currentSlug !== "lead")) return null;
  if (!coop && (s.activeCoopHome || s.activeCoopChannel || s.currentSlug === "lead")) return null;
  var scope = coop ? captureCoopComposerScope() : { scope: "session", topicRef: null, projectRef: null };
  if (!scope) return null;
  return Object.assign(clone(scope), {
    canonicalCoop: coop,
    projectSlug: s.currentSlug,
    sessionId: s.activeSessionId,
    stale: !!scope.stale,
  });
}

export function isCurrentVoiceConversationRouting(route) {
  var current = captureVoiceConversationRouting();
  return isSafeVoiceConversationRouting(route) && isSafeVoiceConversationRouting(current) &&
    route.canonicalCoop === current.canonicalCoop && route.projectSlug === current.projectSlug &&
    String(route.sessionId) === String(current.sessionId);
}
