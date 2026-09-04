// Expandable worktree hierarchy for the desktop project rail. Expansion is
// runtime UI state only; the title-bar branch switcher still owns creation and
// removal so this view stays focused on discovery and navigation.

import { parseEmojis } from './markdown.js';
import { store } from './store.js';
import { switchProject } from './app-projects.js';
import { getPendingTuiAttention } from './app-notifications.js';
import {
  getCurrentDmUserId,
  hideIconTooltip,
  showIconTooltip
} from './sidebar-mates.js';
import { worktreeFamilyExpanded } from './worktree-family.js';

function projectName(project) {
  return project ? (project.title || project.project || project.name || project.slug) : "";
}

function projectAbbrev(name) {
  if (!name) return "?";
  var words = name.replace(/[^a-zA-Z0-9\s]/g, "").trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

function worktreeLabel(worktree) {
  var name = projectName(worktree);
  if (!worktree.branch || worktree.branch === name) return name;
  return name + " · " + worktree.branch;
}

function worktreeNeedsAttention(worktree) {
  return worktree.pendingPermissions > 0 || getPendingTuiAttention(worktree.slug) > 0;
}

function familyNeedsAttention(worktrees) {
  for (var i = 0; i < worktrees.length; i++) {
    if (worktreeNeedsAttention(worktrees[i])) return true;
  }
  return false;
}

function rememberExpanded(parentSlug, expanded) {
  var current = store.get('expandedWorktreeFamilies') || {};
  var next = Object.assign({}, current);
  next[parentSlug] = expanded;
  store.set({ expandedWorktreeFamilies: next });
}

function applyExpanded(group, toggle, items, parent, count, expanded) {
  var action = expanded ? "Hide" : "Show";
  var noun = count === 1 ? "worktree" : "worktrees";
  var label = action + " " + count + " " + noun + " for " + projectName(parent);
  group.classList.toggle("expanded", expanded);
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  items.hidden = !expanded;
}

function appendWorktreeIdentity(el, worktree) {
  if (worktree.icon) {
    var emoji = document.createElement("span");
    emoji.className = "wt-branch-abbrev project-emoji";
    emoji.textContent = worktree.icon;
    parseEmojis(emoji);
    el.appendChild(emoji);
    return;
  }
  var abbrev = document.createElement("span");
  abbrev.className = "wt-branch-abbrev";
  abbrev.textContent = projectAbbrev(projectName(worktree));
  el.appendChild(abbrev);
}

function appendWorktreeStatus(el, worktree) {
  var status = document.createElement("span");
  status.className = "icon-strip-status";
  if (worktree.isProcessing) status.classList.add("processing");
  el.appendChild(status);
}

function createWorktreeItem(worktree, currentSlug) {
  var el = document.createElement("a");
  var accessible = worktree.worktreeAccessible !== false;
  var isActive = worktree.slug === currentSlug && !getCurrentDmUserId();
  el.className = "icon-strip-wt-item" + (isActive ? " active" : "") +
    (accessible ? "" : " wt-disabled");
  el.dataset.slug = worktree.slug;
  if (isActive) el.setAttribute("aria-current", "page");

  appendWorktreeIdentity(el, worktree);
  appendWorktreeStatus(el, worktree);

  var tooltip = worktreeLabel(worktree);
  if (!accessible) tooltip += " (outside project path, cannot be accessed)";
  el.addEventListener("mouseenter", function () { showIconTooltip(el, tooltip); });
  el.addEventListener("mouseleave", hideIconTooltip);

  if (accessible) {
    el.href = "/p/" + worktree.slug + "/";
    el.addEventListener("click", function (event) {
      event.preventDefault();
      switchProject(worktree.slug, { exactProject: true });
    });
  } else {
    el.setAttribute("aria-disabled", "true");
    el.tabIndex = -1;
  }

  if (!isActive && worktreeNeedsAttention(worktree)) el.classList.add("has-pending-perm");
  return el;
}

export function createWorktreeRailGroup(parentItem, parent, worktrees) {
  var group = document.createElement("div");
  group.className = "icon-strip-group";
  group.dataset.parentSlug = parent.slug;

  var header = document.createElement("div");
  header.className = "icon-strip-group-header";
  parentItem.classList.add("folder-header");
  header.appendChild(parentItem);

  var items = document.createElement("div");
  items.className = "icon-strip-group-items";
  items.id = "worktree-rail-" + parent.slug.replace(/[^a-zA-Z0-9_-]/g, "-");
  for (var i = 0; i < worktrees.length; i++) {
    items.appendChild(createWorktreeItem(worktrees[i], store.get('currentSlug')));
  }

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-strip-group-toggle";
  toggle.setAttribute("aria-controls", items.id);
  var branchIcon = document.createElement("i");
  branchIcon.setAttribute("data-lucide", "git-branch");
  toggle.appendChild(branchIcon);
  var count = document.createElement("span");
  count.className = "icon-strip-group-count";
  count.textContent = String(worktrees.length);
  toggle.appendChild(count);

  var currentSlug = store.get('currentSlug');
  var expanded = worktreeFamilyExpanded(
    parent.slug,
    worktrees,
    currentSlug,
    store.get('expandedWorktreeFamilies'),
    familyNeedsAttention(worktrees)
  );
  applyExpanded(group, toggle, items, parent, worktrees.length, expanded);
  toggle.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    expanded = !expanded;
    rememberExpanded(parent.slug, expanded);
    applyExpanded(group, toggle, items, parent, worktrees.length, expanded);
  });
  toggle.addEventListener("mouseenter", function () { showIconTooltip(toggle, toggle.title); });
  toggle.addEventListener("mouseleave", hideIconTooltip);
  toggle.addEventListener("contextmenu", function (event) {
    event.preventDefault();
    event.stopPropagation();
  });

  header.appendChild(toggle);
  group.appendChild(header);
  group.appendChild(items);
  return group;
}
