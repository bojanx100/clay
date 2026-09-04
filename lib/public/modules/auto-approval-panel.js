// Presentation-only helpers for the Coop owner approvals panel. Policy
// enforcement remains server-side; these helpers intentionally expose only
// canonical projects and never surface implementation identifiers.

function readableProjectName(project) {
  var label = project && typeof project.label === "string" ? project.label.trim() : "";
  return label || "Untitled project";
}

function canonicalProjectId(project) {
  return project && project.projectRef && typeof project.projectRef.projectId === "string" ?
    project.projectRef.projectId : null;
}

export function coopApprovalPresentation(result) {
  if (!result || result.scope !== "coop" || !result.state) return null;
  return {
    summary: "Manage automatic approval for each project.",
    projects: projectApprovalPresentation(result.state),
  };
}

export function projectApprovalPresentation(state) {
  var projects = state && Array.isArray(state.projects) ? state.projects : [];
  var seen = {};
  var presentation = [];
  for (var i = 0; i < projects.length; i++) {
    var project = projects[i];
    var projectId = canonicalProjectId(project);
    if (!projectId || seen[projectId]) continue;
    seen[projectId] = true;
    var enabled = !!(project.effective && project.effective.enabled);
    presentation.push({
      enabled: enabled,
      name: readableProjectName(project),
      projectRef: { projectId: projectId },
      toggleLabel: enabled ? "On" : "Off",
      toggleName: "Automatic approval for " + readableProjectName(project),
    });
  }
  return presentation;
}

export function projectApprovalChange(project) {
  var projectId = canonicalProjectId(project);
  if (!projectId) return null;
  return {
    type: "set_auto_approval_project",
    projectRef: { projectId: projectId },
    enabled: !project.enabled,
  };
}
