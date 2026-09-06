// Read-only owner projection. It describes recorded work and provider input,
// not a model's hidden reasoning or proof that it understood the instructions.
function text(value) { return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 400); }

function coordinatorTransparency(root, children, owner) {
  var tasks = root.orchestrationTasks || [];
  var pending = root.pendingCoordinatorUpdates || [];
  var attention = false;
  var working = false;
  function visit(node) {
    if (["blocked", "failed", "needs_input", "waiting_user"].indexOf(node.status) !== -1) attention = true;
    if (["running", "reviewing", "ready", "queued"].indexOf(node.status) !== -1) working = true;
    (node.children || []).forEach(visit);
  }
  children.forEach(visit);
  var receipt = owner && root.coordinatorContextReceipt || null;
  var contextBlocked = receipt && (receipt.contextReady !== true || receipt.state !== "supplied");
  var reportsBlocked = owner && pending.some(function (entry) {
    return entry.state === "attention" || entry.state === "uncertain" || entry.state === "submitting";
  });
  var status = contextBlocked || reportsBlocked || attention ? "needs_input" :
    root.isProcessing ? "running" : working ? "monitoring" : "standby";
  var activity = root.isProcessing ? text(root.currentActivity) || "Reviewing project work" :
    contextBlocked ? "Project context needs attention" : reportsBlocked ? "Report delivery needs review" :
    attention ? "Project work needs attention" : working ? "Assigned work is in progress" : "No active assignments";
  var result = { status: status, activity: activity };
  if (!owner) return result;
  result.transparency = {
    vendor: text(root.vendor), model: text(root.verifiedModel || root.model),
    updatedAt: root.lastActivityAt || root.lastActivity || null,
    pendingReportCount: pending.length,
    pendingAssignmentCount: tasks.filter(function (task) {
      return task.projectAssignment && ["pending", "accepting", "attention"].indexOf(task.projectAssignment.phase) !== -1 &&
        ["completed", "cancelled", "dismissed", "superseded"].indexOf(task.status) === -1;
    }).length,
    context: receipt ? JSON.parse(JSON.stringify(receipt)) : null,
    events: (root.orchestrationEvents || []).slice(-8).reverse().map(function (event) {
      var task = tasks.find(function (item) { return item.taskId === event.taskId; });
      var data = event.data || {};
      return { at: event.at || null, title: text(task && task.title), type: text(event.type),
        summary: text(data.summary || data.reason || data.status || data.message) };
    }),
  };
  return result;
}

module.exports = { coordinatorTransparency: coordinatorTransparency };
