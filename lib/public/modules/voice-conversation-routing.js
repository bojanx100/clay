// A Voice conversation captures its Coop destination before permission or
// recognition starts. The copied reference is the only route a confirmed
// utterance may use; later navigation must not retarget it.

import { captureCoopComposerScope } from './coop-composer-scope.js';

var stagedIngress = null;
var SAFE_SCOPES = {
  canonical: true,
  main: true,
  project: true,
  topic: true,
};

function clone(value) {
  if (!value || typeof value !== "object") return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
}

function cloneRouting(value) {
  if (!value) return null;
  return {
    canonicalCoop: value.canonicalCoop === true,
    stale: !!value.stale,
    scope: typeof value.scope === "string" ? value.scope : null,
    topicRef: clone(value.topicRef),
    projectRef: clone(value.projectRef),
  };
}

function hasReference(value) {
  return !!(value && typeof value === "object" && !Array.isArray(value));
}

export function isSafeVoiceConversationRouting(routing) {
  if (!routing || routing.canonicalCoop !== true || routing.stale ||
      !SAFE_SCOPES[routing.scope]) return false;
  if (routing.scope === "topic") return hasReference(routing.topicRef);
  if (routing.scope === "project") return hasReference(routing.projectRef);
  return !routing.topicRef && !routing.projectRef;
}

export function captureVoiceConversationRouting() {
  var active = captureCoopComposerScope();
  return cloneRouting(active ? Object.assign({ canonicalCoop: true }, active) : {
    canonicalCoop: false,
    stale: false,
    scope: null,
    topicRef: null,
    projectRef: null,
  });
}

export function stageVoiceConversationIngress(routing) {
  var copied = cloneRouting(routing);
  if (!isSafeVoiceConversationRouting(copied)) return false;
  stagedIngress = copied;
  return true;
}

export function takeVoiceConversationIngress() {
  var copied = cloneRouting(stagedIngress);
  stagedIngress = null;
  return copied;
}

export function clearVoiceConversationIngress() {
  stagedIngress = null;
}
