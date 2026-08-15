// Pure helpers for presenting worktree projects as branches of one family.

function projectName(project) {
  return project ? (project.title || project.project || project.name || project.slug) : "";
}

export function familyOf(projects, slug) {
  var list = projects || [];
  var current = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].slug === slug) { current = list[i]; break; }
  }
  if (!current) return { parent: null, worktrees: [] };

  var parentSlug = current.isWorktree ? current.parentSlug : current.slug;
  var parent = current.isWorktree ? null : current;
  var worktrees = [];
  for (var j = 0; j < list.length; j++) {
    var project = list[j];
    if (!parent && project.slug === parentSlug && !project.isWorktree) parent = project;
    if (project.isWorktree && project.parentSlug === parentSlug) worktrees.push(project);
  }
  if (current.isWorktree && worktrees.indexOf(current) === -1) worktrees.push(current);
  worktrees.sort(function (a, b) { return projectName(a).localeCompare(projectName(b)); });
  return { parent: parent, worktrees: worktrees };
}

export function parentProjects(projects) {
  return (projects || []).filter(function (project) { return !project.isWorktree; });
}

export function displayProject(projects, slug) {
  var family = familyOf(projects, slug);
  if (family.parent) return family.parent;
  for (var i = 0; i < (projects || []).length; i++) {
    if (projects[i].slug === slug) return projects[i];
  }
  return null;
}

export function aggregateFamily(parent, worktrees) {
  var result = Object.assign({}, parent);
  var children = worktrees || [];
  result.isProcessing = !!result.isProcessing;
  result.unread = result.unread || 0;
  result.pendingPermissions = result.pendingPermissions || 0;
  for (var i = 0; i < children.length; i++) {
    result.isProcessing = result.isProcessing || !!children[i].isProcessing;
    result.unread += children[i].unread || 0;
    result.pendingPermissions += children[i].pendingPermissions || 0;
  }
  return result;
}

export function switcherProjectName(projects, project) {
  if (!project || !project.isWorktree) return projectName(project);
  var family = familyOf(projects, project.slug);
  var parentName = family.parent ? projectName(family.parent) : (project.parentSlug || "Project");
  return parentName + " \u2387 " + (project.branch || projectName(project));
}
