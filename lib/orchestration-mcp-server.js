var z;
try { z = require("zod"); } catch (e) { z = null; }

function stringField(description, optional) {
  if (!z) return {};
  var field = z.string().describe(description);
  return optional ? field.optional() : field;
}

function numberField(description) {
  if (!z) return {};
  return z.number().describe(description);
}

function getToolDefs(onDelegate, onMessage) {
  return [{
    name: "delegate_task",
    description: "Delegate a fully specified bounded task to a Clay worker. The worker runs independently and its structured result returns automatically to this coordinator session.",
    inputSchema: {
      coordinatorSessionId: numberField("Local session id stated in the coordinator instructions"),
      title: stringField("Short task title"),
      objective: stringField("Complete, unambiguous worker objective"),
      context: stringField("Relevant conversation, product, and technical context"),
      acceptanceCriteria: stringField("Observable completion and verification criteria"),
      ownedPaths: stringField("Files, directories, or subsystem this worker may change; use read-only when it must not edit"),
      provider: stringField("Optional provider: claude, codex, or github-copilot", true),
      model: stringField("Optional exact model; omit to inherit the coordinator route", true),
    },
    handler: function (args) {
      return Promise.resolve(onDelegate(args || {}));
    },
  }, {
    name: "send_task_message",
    description: "Send new context, an answer, or a correction to an existing owned worker task. Use this when user input belongs to work already in progress.",
    inputSchema: {
      coordinatorSessionId: numberField("Local session id stated in the coordinator instructions"),
      taskId: stringField("Stable task id returned by delegate_task"),
      message: stringField("Context, answer, or correction for the worker"),
    },
    handler: function (args) {
      return Promise.resolve(onMessage(args || {}));
    },
  }];
}

module.exports = {
  getToolDefs: getToolDefs,
};
