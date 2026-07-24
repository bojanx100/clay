function orchestrationTasksForClient(session) {
  var tasks = session && session.orchestrationTasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(function (task) {
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      workerSessionId: task.workerSessionId,
      provider: task.provider || null,
      model: task.model || null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  });
}

module.exports = {
  orchestrationTasksForClient: orchestrationTasksForClient,
};
