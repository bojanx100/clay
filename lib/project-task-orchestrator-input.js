function requestTaskInput(updateTask, parentSession, tasks, question, reason) {
  for (var i = 0; i < tasks.length; i++) {
    updateTask(parentSession, tasks[i].taskId, {
      status: "waiting_user",
      currentActivity: "Waiting for one user decision",
      userQuestion: question,
      waitingReason: reason,
      userAnsweredAt: null,
      resolutionReason: "",
      resolutionSummary: "",
      resolvedAt: null,
    });
  }
}

module.exports = { requestTaskInput: requestTaskInput };
