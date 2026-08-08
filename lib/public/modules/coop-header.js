// coop-header.js - The one place that writes the chat header title.
//
// Six code paths used to write #header-title, each from a different source, and
// each had to remember the Coop rules on its own. That is why a selected topic
// kept reverting to "Coop": the lens was applied once, then the next session
// switch / sidebar render / info frame / project-list update painted over it.
//
// They now all route through applyCoopChatHeader(), and the store subscription
// below re-applies it whenever anything the title depends on changes -- lens,
// project, session title, or a projection refresh that finally carries the
// canonical topic name. A later repaint cannot win, because the last word is
// always this function.

import { store } from './store.js';
import { activeCoopLensDisplay, activeCoopLensScope } from './global-coop-projection.js';
import { coopChatHeaderTitle, coopHeaderTitle, isCoopProjectSlug } from './coop-identity.js';

// Set by the app once the header element exists; DM mode owns the header while
// it is open and is handled by app-messages-dm.js.
function headerEl() {
  return document.getElementById("header-title");
}

function inMateDm() {
  return !!store.get('dmMode') || document.body.classList.contains("mate-dm-active");
}

// candidate/fallback describe the non-Coop case (an ordinary project's session
// title and project name). Inside Coop they are ignored in favour of the lens.
export function resolveCoopChatHeader(candidate, fallback) {
  var slug = store.get('currentSlug');
  return coopChatHeaderTitle(slug, activeCoopLensDisplay(), candidate, fallback);
}

// The lens the transcript is currently showing. Blocks are marked at creation
// and revealed or hidden by this one attribute, so switching Main <-> All is
// instant and cannot duplicate, drop or reorder a block: the same DOM is simply
// filtered differently.
export function applyCoopLensAttribute() {
  var el = document.getElementById("messages");
  if (!el) return "";
  var scope = isCoopProjectSlug(store.get('currentSlug')) ? activeCoopLensScope() : "";
  if (el.dataset.coopLens !== scope) el.dataset.coopLens = scope;
  return scope;
}

export function applyCoopChatHeader(candidate, fallback) {
  applyCoopLensAttribute();
  if (inMateDm()) return null;
  var title = resolveCoopChatHeader(candidate, fallback);
  var el = headerEl();
  if (el && title && el.textContent !== title) el.textContent = title;
  // The title bar keeps naming the project, not the lens.
  var slug = store.get('currentSlug');
  if (isCoopProjectSlug(slug)) {
    var bar = document.getElementById("title-bar-project-name");
    var projectName = coopHeaderTitle(slug, null, null);
    if (bar && bar.textContent !== projectName) bar.textContent = projectName;
  }
  return title;
}

// Re-apply on every input the title derives from. coopProjectionVersion is what
// covers delayed projection delivery: the lens can be restored from a URL or
// history entry before the projection carrying its canonical title arrives, and
// this repaints the heading the moment it does.
store.subscribe(function (state, previous) {
  if (state.currentSlug !== previous.currentSlug ||
      state.activeCoopLens !== previous.activeCoopLens ||
      state.activeCoopTopicRef !== previous.activeCoopTopicRef ||
      state.activeCoopHome !== previous.activeCoopHome ||
      state.activeSessionTitle !== previous.activeSessionTitle ||
      state.coopProjectionVersion !== previous.coopProjectionVersion ||
      state.activeCoopLensScope !== previous.activeCoopLensScope ||
      state.activeCoopProjectRef !== previous.activeCoopProjectRef) {
    applyCoopChatHeader(state.activeSessionTitle, state.projectName);
  }
});
