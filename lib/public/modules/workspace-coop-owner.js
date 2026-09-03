// Coop-only work-tracker content for the Workspace panel.
//
// The durable portfolio projection is already ACL-filtered server-side. This
// module only decides whether the active Workspace view is the canonical Coop
// conversation and mounts the shared ref-only renderer there.

import { store } from './store.js';
import { getGlobalCoopProjection } from './global-coop-projection.js';
import { renderCoopOwnerSidebar } from './coop-owner-sidebar.js';
import { refreshIcons } from './icons.js';

function currentSession(sessions) {
  var activeId = String(store.get("activeSessionId") || "");
  var list = Array.isArray(sessions) ? sessions : [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i] && list[i].id || "") === activeId) return list[i];
  }
  return null;
}

export function hasCoopOwnerContext(sessions) {
  if (store.get("currentSlug") !== "lead") return false;
  var active = currentSession(sessions);
  var projection = getGlobalCoopProjection();
  return !!(active && active.coopHome && projection && projection.ownerSidebar);
}

export function syncWorkspaceOwnerRefreshControl(button, sessions) {
  var ownerMode = hasCoopOwnerContext(sessions);
  if (!button) return ownerMode;
  button.hidden = ownerMode;
  button.disabled = ownerMode;
  if (ownerMode) button.setAttribute("aria-hidden", "true");
  else button.removeAttribute("aria-hidden");
  return ownerMode;
}

export function shouldDefaultOpenCoopOwnerLedger(sessions) {
  var projection = getGlobalCoopProjection();
  return hasCoopOwnerContext(sessions) && projection.ownerSidebar.defaultOpen === true;
}

// The count the owner is owed, taken verbatim from the server. Re-deriving it
// from the rendered sections here is how two surfaces come to disagree, and an
// absent count renders nothing rather than a confident zero.
function appendOpenWorkCount(heading, sidebar) {
  var counts = sidebar && sidebar.counts || {};
  if (typeof counts.openWork !== "number") return;
  var badge = document.createElement("span");
  badge.className = "workspace-coop-owner-open-count";
  badge.textContent = counts.openWork + " open";
  badge.setAttribute("aria-label", counts.openWork + " pieces of open work");
  heading.appendChild(badge);
}

export function renderWorkspaceCoopOwner(container, options) {
  var projection = getGlobalCoopProjection();
  if (!container || !projection || !projection.ownerSidebar) return false;
  var opts = Object.assign({}, options || {}, {
    details: store.get("coopOwnerLedgerDetails") || {},
    onDetailsChange: function (details) { store.set({ coopOwnerLedgerDetails: details }); },
  });
  container.innerHTML = "";
  var surface = document.createElement("div");
  surface.className = "workspace-coop-owner";
  var heading = document.createElement("div");
  heading.className = "workspace-coop-owner-title";
  heading.textContent = "Owner work ledger";
  appendOpenWorkCount(heading, projection.ownerSidebar);
  surface.appendChild(heading);
  var rendered = renderCoopOwnerSidebar(surface, projection.ownerSidebar, opts);
  if (rendered === 0) {
    var empty = document.createElement("div");
    empty.className = "ws-empty-callout workspace-coop-owner-empty";
    empty.textContent = "No owner work has been recorded yet.";
    surface.appendChild(empty);
  }
  container.appendChild(surface);
  refreshIcons();
  return true;
}
