function attachExternalTaskRouting(ctx) {
  var coordinateExternalTask = ctx.coordinateExternalTask;

  function routeExternalTask(body, recipe, item, user) {
    if (!body || !body.coordinatorSessionId) return null;
    if (!coordinateExternalTask) {
      return { ok: false, error: "Coordinator task routing is unavailable" };
    }
    var sourceContext = String(body.context || "").trim();
    var contextParts = ["Task source: " + String(body.source || "external") + "."];
    if (sourceContext) contextParts.push(sourceContext);
    return coordinateExternalTask({
      coordinatorSessionId: body.coordinatorSessionId,
      title: ctx.renderTitle(recipe, item),
      objective: ctx.renderPrompt(recipe, item),
      context: contextParts.join("\n\n"),
      acceptanceCriteria: String(body.acceptanceCriteria ||
        "Complete the requested work, verify it, and return a structured worker report."),
      ownedPaths: String(body.ownedPaths ||
        "Infer the smallest safe ownership boundary from the task and supplied design context."),
      clientRef: body.clientRef ? String(body.clientRef) : null,
      provider: body.vendor ? ctx.normalizeVendor(String(body.vendor)) : null,
      model: body.model ? String(body.model) : null,
      user: user || null,
    });
  }

  return {
    routeExternalTask: routeExternalTask,
  };
}

module.exports = {
  attachExternalTaskRouting: attachExternalTaskRouting,
};
