// Coop-only owner control content for the Session Context panel.
//
// The durable portfolio projection is already ACL-filtered server-side. This
// module only decides whether the active Session Context is the canonical Coop
// conversation and mounts the shared ref-only renderer there.

import { store } from './store.js';
import { getGlobalCoopProjection } from './global-coop-projection.js';
import { renderCoopOwnerSidebar } from './coop-owner-sidebar.js';

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

export function renderWorkspaceCoopOwner(container, options) {
  var projection = getGlobalCoopProjection();
  if (!container || !projection || !projection.ownerSidebar) return false;
  var opts = options || {};
  container.innerHTML = "";
  var surface = document.createElement("div");
  surface.className = "workspace-coop-owner";
  var heading = document.createElement("div");
  heading.className = "workspace-coop-owner-title";
  heading.textContent = "Owner control";
  surface.appendChild(heading);
  var rendered = renderCoopOwnerSidebar(surface, projection.ownerSidebar, opts);
  if (rendered === 0) {
    var empty = document.createElement("div");
    empty.className = "ws-empty-callout workspace-coop-owner-empty";
    empty.textContent = "No portfolio work needs your attention.";
    surface.appendChild(empty);
  }
  container.appendChild(surface);
  return true;
}
