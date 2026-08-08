// coop-action-queue-ui.js - The owner's "Action required" queue, rendered at the
// top of Coop on desktop and mobile.
//
// One row per real decision. Never a row for an internal coordinator, and never
// two rows for the same work: the server decides both, so the two surfaces
// cannot drift and the queue cannot disagree with itself between viewports.
//
// Each row states the four things the owner needs to act: which project, what
// the work is, exactly what is being asked, and where tapping it goes.

import { store } from './store.js';

// Deliberately NO app-projects.js import. That module is the application hub
// (favicon, filebrowser, scheduler, sticky notes, the whole graph), and this
// module is reached from sidebar-coop-topics.js and global-coop-projection.js,
// which many tests load standalone. Importing it here dragged the entire app
// into both and broke 70 unrelated tests at module load. Navigation is injected
// by the two surface modules instead; they already sit at the top of the graph.

function text(value, fallback) {
  var out = typeof value === "string" ? value.trim() : "";
  return out || fallback || "";
}

export function normalizeActionQueue(message) {
  var items = message && Array.isArray(message.actionQueue) ? message.actionQueue : [];
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    var itemId = text(item.itemId, "");
    if (!itemId) continue;
    out.push({
      itemId: itemId,
      projectRef: item.projectRef || null,
      projectSlug: text(item.projectSlug, ""),
      projectTitle: text(item.projectTitle, "Project"),
      title: text(item.title, "Untitled work"),
      decision: text(item.decision, "Needs your attention"),
      status: text(item.status, "needs_input"),
      destination: item.destination || null,
      hasExistingSession: !!item.hasExistingSession,
      links: Array.isArray(item.links) ? item.links.filter(function (link) {
        return link && text(link.url, "");
      }).map(function (link) {
        return { label: text(link.label, "Link"), url: text(link.url, "") };
      }) : [],
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
    });
  }
  return out;
}

export function getActionQueue() {
  return store.get("coopActionQueue") || [];
}

export function setActionQueue(items) {
  store.set({ coopActionQueue: items || [] });
}

// The queue is NOT part of the cloned projection, so globalCoopProjectionSignature
// cannot see it. Without this term a task flipping to needs_input, or an item
// being resolved, would change the queue while leaving the session-list
// signature identical -- and canSkipSessionListRender would suppress the
// repaint. That is the same failure that made Main unselectable, so the queue
// contributes its own term rather than relying on something else changing too.
export function actionQueueSignature() {
  var items = getActionQueue();
  var parts = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    parts.push([
      item.itemId,
      item.status,
      item.title,
      item.decision,
      item.destination && item.destination.ref &&
        item.destination.ref.sessionStorageId || "",
      String(item.links.length),
    ].join("~"));
  }
  return parts.join(";");
}

// Tapping a row goes straight to the work: the existing session when there is
// one, otherwise the project. It never opens a coordinator, and never starts a
// second session for work that already has one.
function openActionItem(item, options) {
  var opts = options || {};
  // Injected by the surface, which owns the app-graph imports. This is also
  // what lets a test click the real rendered button and observe where it went,
  // instead of re-deriving the destination and asserting on itself.
  var openSession = typeof opts.openSession === "function" ? opts.openSession : null;
  var openProject = typeof opts.openProject === "function" ? opts.openProject : null;
  // openResolvedGlobalSession accepts only { ref, slug, localId } and returns
  // false on anything else, so check the shape here rather than discovering it
  // as a click that silently does nothing.
  var to = item.destination;
  var openable = !!(to && to.ref && to.slug && typeof to.localId === "number");
  if (openable && openSession) {
    openSession(to);
  } else if (item.projectSlug && openProject) {
    openProject(item.projectSlug);
  }
  if (typeof opts.onNavigate === "function") opts.onNavigate();
}

function linkRow(prefix, item) {
  if (!item.links.length) return null;
  var wrap = document.createElement("div");
  wrap.className = prefix + "action-item-links";
  for (var i = 0; i < item.links.length; i++) {
    (function (link) {
      var anchor = document.createElement("a");
      anchor.className = prefix + "action-item-link";
      anchor.href = link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = link.label;
      // The row itself navigates into Clay; a link goes out to the issue or PR.
      anchor.addEventListener("click", function (e) { e.stopPropagation(); });
      wrap.appendChild(anchor);
    })(item.links[i]);
  }
  return wrap;
}

function createActionRow(item, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-action-item";
  row.dataset.actionItemId = item.itemId;
  row.setAttribute("aria-label",
    item.projectTitle + ", " + item.title + ", " + item.decision);

  var head = document.createElement("span");
  head.className = prefix + "coop-action-item-head";

  var project = document.createElement("span");
  project.className = prefix + "coop-action-item-project";
  project.textContent = item.projectTitle;
  head.appendChild(project);

  var title = document.createElement("span");
  title.className = prefix + "coop-action-item-title";
  title.textContent = item.title;
  head.appendChild(title);
  row.appendChild(head);

  // The exact thing being asked, in the worker's own words when it asked one.
  var decision = document.createElement("span");
  decision.className = prefix + "coop-action-item-decision";
  decision.textContent = item.decision;
  row.appendChild(decision);

  row.addEventListener("click", function () { openActionItem(item, opts); });

  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-action-item-wrapper";
  wrapper.appendChild(row);
  var links = linkRow(prefix, item);
  if (links) wrapper.appendChild(links);
  return wrapper;
}

// Renders the queue, or nothing at all when it is empty. An empty queue means
// the owner is not being asked for anything, and a heading saying so is noise.
export function renderCoopActionQueue(container, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var items = opts.items || getActionQueue();
  if (!items.length) return 0;

  var section = document.createElement("section");
  section.className = prefix + "coop-action-queue";

  var heading = document.createElement("div");
  heading.className = prefix + "coop-action-queue-heading";
  heading.id = prefix + "coop-action-queue-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "2");
  heading.textContent = "Action required";
  section.appendChild(heading);
  section.setAttribute("aria-labelledby", heading.id);

  for (var i = 0; i < items.length; i++) {
    section.appendChild(createActionRow(items[i], opts));
  }
  container.appendChild(section);
  return items.length;
}
