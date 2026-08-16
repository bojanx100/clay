// A Voice conversation captures its Coop destination before permission or
// recognition starts. The copied reference is the only route a confirmed
// utterance may use; later navigation must not retarget it.

import { captureCoopComposerScope } from './coop-composer-scope.js';

var stagedIngress = null;

function clone(value) {
  if (!value || typeof value !== "object") return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
}

function cloneRouting(value) {
  if (!value) return null;
  return {
    stale: !!value.stale,
    scope: typeof value.scope === "string" ? value.scope : null,
    topicRef: clone(value.topicRef),
    projectRef: clone(value.projectRef),
  };
}

export function captureVoiceConversationRouting() {
  var active = captureCoopComposerScope();
  return cloneRouting(active || {
    stale: false,
    scope: null,
    topicRef: null,
    projectRef: null,
  });
}

export function stageVoiceConversationIngress(routing) {
  var copied = cloneRouting(routing);
  if (!copied || copied.stale || !copied.scope) return false;
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
