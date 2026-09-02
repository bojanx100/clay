// Presentation-only helpers for the owner-facing project approvals panel.
// Policy enforcement remains server-side; these helpers intentionally expose
// only canonical projects and never surface implementation identifiers.

function readableProjectName(project) {
  var label = project && typeof project.label === "string" ? project.label.trim() : "";
  return label || "Untitled project";
}

function canonicalProjectId(project) {
  return project && project.projectRef && typeof project.projectRef.projectId === "string" ?
    project.projectRef.projectId : null;
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
    var hasOverride = project.hasOverride === true;
    presentation.push({
      actionLabel: enabled ? "Turn automatic approval off" : "Turn automatic approval on",
      enabled: enabled,
      name: readableProjectName(project),
      projectRef: { projectId: projectId },
      sourceLabel: hasOverride ? "Project setting" : "Default policy",
      statusLabel: enabled ? "Automatic approval on" : "Approval required",
    });
  }
  return presentation;
}
