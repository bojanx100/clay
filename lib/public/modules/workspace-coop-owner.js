// Coop-only work-tracker content for the Workspace panel.
//
// The durable portfolio projection is already ACL-filtered server-side. This
// module only decides whether the active Workspace view is the canonical Coop
// conversation and mounts the shared ref-only renderer there.

import { store } from './store.js';
import { getGlobalCoopProjection } from './global-coop-projection.js';
import { renderCoopOwnerSidebar } from './coop-owner-sidebar.js';
import { workspaceGroupPreferencesReady } from './workspace-group-collapse.js';

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

export function shouldDefaultOpenCoopOwnerLedger(sessions) {
  var projection = getGlobalCoopProjection();
  return hasCoopOwnerContext(sessions) && projection.ownerSidebar.defaultOpen === true;
}

function renderOwnerLedgerPreferenceLoading(container) {
  container.innerHTML = "";
  var surface = document.createElement("div");
  surface.className = "workspace-coop-owner";
  var heading = document.createElement("div");
  heading.className = "workspace-coop-owner-title";
  heading.textContent = "Owner work ledger";
  surface.appendChild(heading);
  var loading = document.createElement("p");
  loading.className = "workspace-coop-owner-loading";
  loading.setAttribute("role", "status");
  loading.textContent = "Loading saved group layout…";
  surface.appendChild(loading);
  container.appendChild(surface);
}

export function renderWorkspaceCoopOwner(container, options) {
  var projection = getGlobalCoopProjection();
  if (!container || !projection || !projection.ownerSidebar) return false;
  if (!workspaceGroupPreferencesReady()) {
    renderOwnerLedgerPreferenceLoading(container);
    return true;
  }
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
  surface.appendChild(heading);
  var rendered = renderCoopOwnerSidebar(surface, projection.ownerSidebar, opts);
  if (rendered === 0) {
    var empty = document.createElement("div");
    empty.className = "ws-empty-callout workspace-coop-owner-empty";
    empty.textContent = "No owner work has been recorded yet.";
    surface.appendChild(empty);
  }
  container.appendChild(surface);
  return true;
}
