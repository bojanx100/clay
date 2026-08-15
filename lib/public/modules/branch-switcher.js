// Title-bar branch switcher for a project and its worktrees.

import { store } from './store.js';
import { iconHtml, refreshIcons } from './icons.js';
import { escapeHtml } from './utils.js';
import { familyOf } from './worktree-family.js';
import { switchProject, confirmRemoveProject } from './app-projects.js';
import { showWorktreeModal } from './sidebar-projects.js';

var chip = null;
var label = null;
var menu = null;
var menuOpen = false;
var defaultBranches = {};
// slug -> true/false once /api/branches answers; undefined while unknown.
// Non-git projects hide the chip (no worktrees to manage there).
var gitRepoBySlug = {};

function projectName(project) {
  return project ? (project.title || project.project || project.name || project.slug) : "";
}

function currentProject(projects) {
  var slug = store.get('currentSlug');
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].slug === slug) return projects[i];
  }
  return null;
}

function defaultBranch(parent) {
  return defaultBranches[parent.slug] || "default";
}

function requestDefaultBranch(parent) {
  if (!parent || Object.prototype.hasOwnProperty.call(defaultBranches, parent.slug)) return;
  defaultBranches[parent.slug] = null;
  fetch("/p/" + encodeURIComponent(parent.slug) + "/api/branches")
    .then(function (response) { return response.json(); })
    .then(function (data) {
      defaultBranches[parent.slug] = data.defaultBranch || "default";
      gitRepoBySlug[parent.slug] = data.isGitRepo !== false;
      renderBranchSwitcher();
    })
    .catch(function () {
      defaultBranches[parent.slug] = "default";
      renderBranchSwitcher();
    });
}

function closeMenu() {
  menuOpen = false;
  if (menu) menu.classList.add("hidden");
  if (chip) {
    chip.classList.remove("open");
    chip.setAttribute("aria-expanded", "false");
  }
}

function positionMenu() {
  if (!chip || !menu || !menuOpen) return;
  var rect = chip.getBoundingClientRect();
  var left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
  var top = rect.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 6;
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = Math.max(8, top) + "px";
}

function branchLabel(project, parent) {
  return project.isWorktree ? (project.branch || projectName(project)) : defaultBranch(parent);
}

function appendProjectRow(container, project, parent, isCurrent) {
  var row = document.createElement("div");
  row.className = "branch-chip-row" + (isCurrent ? " current" : "");
  var inaccessible = project.isWorktree && project.worktreeAccessible === false;
  var main = document.createElement("button");
  main.className = "branch-chip-row-main";
  main.disabled = inaccessible;
  if (inaccessible) main.title = "Outside project path";
  main.innerHTML = iconHtml("git-branch") + '<span class="branch-chip-row-label">' +
    escapeHtml(branchLabel(project, parent)) + "</span>";
  if (project.isProcessing) {
    var dot = document.createElement("span");
    dot.className = "branch-chip-processing";
    main.appendChild(dot);
  }
  if (project.pendingPermissions > 0) {
    var badge = document.createElement("span");
    badge.className = "branch-chip-pending";
    badge.textContent = project.pendingPermissions > 99 ? "99+" : String(project.pendingPermissions);
    main.appendChild(badge);
  }
  if (isCurrent) main.insertAdjacentHTML("beforeend", iconHtml("check"));
  if (!inaccessible) {
    main.addEventListener("click", function () { closeMenu(); switchProject(project.slug); });
  }
  row.appendChild(main);

  if (project.isWorktree && (!store.get('permissions') || store.get('permissions').deleteProject !== false)) {
    var remove = document.createElement("button");
    remove.className = "branch-chip-row-action";
    remove.title = "Remove worktree";
    remove.innerHTML = iconHtml("trash-2");
    remove.addEventListener("click", function (event) {
      event.stopPropagation();
      closeMenu();
      confirmRemoveProject(project.slug, projectName(project));
    });
    row.appendChild(remove);
  }
  container.appendChild(row);
}

function renderMenu(family, current) {
  menu.innerHTML = "";
  if (family.parent) appendProjectRow(menu, family.parent, family.parent, current.slug === family.parent.slug);
  for (var i = 0; i < family.worktrees.length; i++) {
    appendProjectRow(menu, family.worktrees[i], family.parent || family.worktrees[i], current.slug === family.worktrees[i].slug);
  }
  if (family.parent) {
    var footer = document.createElement("button");
    footer.className = "branch-chip-new";
    footer.innerHTML = iconHtml("plus") + " <span>New worktree...</span>";
    footer.addEventListener("click", function () {
      closeMenu();
      showWorktreeModal(family.parent.slug, projectName(family.parent));
    });
    menu.appendChild(footer);
  }
  refreshIcons();
  positionMenu();
}

export function renderBranchSwitcher() {
  if (!chip) return;
  var projects = store.get('projects') || [];
  var current = currentProject(projects);
  var family = current ? familyOf(projects, current.slug) : { parent: null, worktrees: [] };
  // The chip is the project's worktree management surface, so it shows even
  // with zero worktrees (the menu then offers the default branch and "New
  // worktree"). Hidden where there is no project context to manage, and for
  // non-git projects (optimistically visible until /api/branches answers).
  var gateSlug = family.parent ? family.parent.slug : (current ? current.slug : null);
  var hidden = !current || store.get('dmMode') || store.get('mateProjectSlug') ||
    store.get('homeHubVisible') || (gateSlug && gitRepoBySlug[gateSlug] === false);
  chip.classList.toggle("hidden", hidden);
  if (hidden) { closeMenu(); return; }
  if (family.parent) requestDefaultBranch(family.parent);
  label.textContent = branchLabel(current, family.parent || current);
  if (menuOpen) renderMenu(family, current);
}

export function initBranchSwitcher() {
  chip = document.getElementById("branch-chip");
  label = document.getElementById("branch-chip-label");
  menu = document.getElementById("branch-chip-menu");
  if (!chip || !label || !menu) return;
  chip.addEventListener("click", function (event) {
    event.stopPropagation();
    menuOpen = !menuOpen;
    chip.classList.toggle("open", menuOpen);
    chip.setAttribute("aria-expanded", menuOpen ? "true" : "false");
    menu.classList.toggle("hidden", !menuOpen);
    renderBranchSwitcher();
  });
  document.addEventListener("click", function (event) {
    if (menuOpen && !menu.contains(event.target) && !chip.contains(event.target)) closeMenu();
  });
  window.addEventListener("resize", positionMenu);
  store.subscribe(function (state, prev) {
    if (state.projects !== prev.projects || state.currentSlug !== prev.currentSlug ||
        state.dmMode !== prev.dmMode || state.mateProjectSlug !== prev.mateProjectSlug ||
        state.homeHubVisible !== prev.homeHubVisible) renderBranchSwitcher();
  });
  renderBranchSwitcher();
}
