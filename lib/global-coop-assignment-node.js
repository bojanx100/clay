var assignment = require("./coop-project-assignment");
var identity = require("./project-identity");
var graph = require("./orchestration-task-graph");

function pendingAssignmentNode(root, task, projectId) {
  if (!assignment.valid(root, task) || assignment.closed(task) || task.archivedAt ||
      task.projectAssignment.phase === "accepted" || task.workerSessionRef || task.workerStorageId ||
      task.projectAssignment.payload.targetProject.projectId !== projectId) return null;
  var dependencies = graph.dependencyState(root, task);
  return {
    sessionRef: null,
    coordinatorRef: identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, root),
    taskRef: assignment.taskRef(root, task),
    projectRef: { projectId: projectId },
    title: String(task.title || "Project assignment").trim().slice(0, 240),
    role: "project_assignment",
    assignmentPhase: task.projectAssignment.phase,
    status: task.status || "queued",
    activity: String(task.currentActivity || "Awaiting project coordinator acceptance").slice(0, 1000),
    updatedAt: task.updatedAt || task.createdAt || null,
    dependencies: (task.dependencies || []).map(function (id) {
      return graph.findTask(root, id);
    }).filter(Boolean).map(function (dependency) { return assignment.taskRef(root, dependency); }),
    dependencyState: dependencies.waiting.length || dependencies.failed.length ? "waiting" : "independent",
    children: [],
  };
}

module.exports = { pendingAssignmentNode: pendingAssignmentNode };
