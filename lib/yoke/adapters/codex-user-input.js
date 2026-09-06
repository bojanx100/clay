// Codex request_user_input has a question-id -> { answers: string[] } reply.
// It shares Clay's question form, but not the MCP elicitation reply protocol.
function createUserInputRequests(onElicitation, respond, signal) {
  var pending = new Map();
  function resolved(id) {
    var current = pending.get(id);
    if (!current) return;
    pending.delete(id);
    current.abort();
  }
  function cancelAll() { Array.from(pending.keys()).forEach(resolved); }
  if (signal) signal.addEventListener("abort", cancelAll, { once: true });
  function handle(message) {
    var questions = (message.params || {}).questions || [];
    resolved(message.id);
    var controller = new AbortController();
    pending.set(message.id, controller);
    var properties = Object.create(null);
    questions.forEach(function (q) {
      var property = { type: "string", description: q.question, title: q.header || q.question };
      if (q.options && q.options.length && !q.isOther) property.enum = q.options.map(function (option) { return option.label; });
      if (q.isSecret) property.format = "password";
      properties[q.id] = property;
    });
    var request = {
      serverName: "Codex", message: "Please answer these questions.", mode: "form",
      questionKind: "codex_user_input", questions: questions,
      requestedSchema: { type: "object", properties: properties, required: questions.map(function (q) { return q.id; }) },
    };
    Promise.resolve().then(function () {
      if (controller.signal.aborted) return null;
      return onElicitation ? onElicitation(request, { signal: controller.signal }) : null;
    }).then(function (result) {
      if (pending.get(message.id) !== controller) return;
      pending.delete(message.id);
      var answers = Object.create(null);
      questions.forEach(function (q) {
        var value = result && result.action === "accept" && result.content && result.content[q.id];
        answers[q.id] = { answers: typeof value === "string" ? [value] :
          Array.isArray(value) && value.every(function (item) { return typeof item === "string"; }) ? value : [] };
      });
      respond(message.id, { answers: answers });
    }).catch(function () {
      if (pending.get(message.id) !== controller) return;
      pending.delete(message.id);
      respond(message.id, { answers: {} });
    });
  }
  return { handle: handle, resolved: resolved, cancelAll: cancelAll };
}
module.exports = { createUserInputRequests: createUserInputRequests };
