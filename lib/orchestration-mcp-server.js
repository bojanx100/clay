var z;
try { z = require("zod"); } catch (e) { z = null; }

function stringField(description, optional) {
  if (!z) return {};
  var field = z.string().describe(description);
  return optional ? field.optional() : field;
}

function coordinatorIdField(description) {
  if (!z) return {};
  return z.union([z.string(), z.number()]).describe(description);
}

function getToolDefs(onDelegate, onMessage, onPlan, onReport, onRetry, onAdopt, onResolve) {
  return [{
    name: "delegate_task",
    description: "Delegate a fully specified bounded task to a visible, durable Clay worker. The first delegation can automatically promote an ordinary top-level conversation to a coordinator. The worker runs independently and its structured result returns automatically.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      title: stringField("Short task title"),
      objective: stringField("Complete, unambiguous worker objective"),
      context: stringField("Relevant conversation, product, and technical context"),
      acceptanceCriteria: stringField("Observable completion and verification criteria"),
      ownedPaths: stringField("Files, directories, or subsystem this worker may change; use read-only when it must not edit"),
      provider: stringField("Optional provider: claude, codex, or github-copilot", true),
      model: stringField("Optional exact model; omit to inherit the coordinator route", true),
      difficulty: z ? z.enum(["routine", "strong"]).optional().describe("Optional routing tier; omit for deterministic classification") : {},
    },
    handler: function (args) {
      return Promise.resolve(onDelegate(args || {}));
    },
  }, {
    name: "send_task_message",
    description: "Send new context, an answer, or a correction to an existing owned worker task. Use this when user input belongs to work already in progress.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskId: stringField("Stable task id returned by delegate_task"),
      message: stringField("Context, answer, or correction for the worker"),
    },
    handler: function (args) {
      return Promise.resolve(onMessage(args || {}));
    },
  }, {
    name: "plan_task_graph",
    description: "Create multiple visible, durable worker tasks as one graph. The first plan can automatically promote an ordinary top-level conversation to a coordinator. Independent tasks start in parallel; tasks with dependencies start automatically after their prerequisites complete.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      maxParallel: z ? z.number().min(1).max(10).optional().describe("Maximum concurrent workers for this coordinator") : {},
      tasks: z ? z.array(z.object({
        ref: z.string().optional().describe("Short reference used by dependencies in this batch"),
        title: z.string(),
        objective: z.string(),
        context: z.string().optional(),
        acceptanceCriteria: z.string().optional(),
        ownedPaths: z.string().optional(),
        dependencies: z.array(z.string()).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        difficulty: z.enum(["routine", "strong"]).optional(),
        maxAttempts: z.number().optional(),
      })) : {},
    },
    handler: function (args) {
      return Promise.resolve(onPlan(args || {}));
    },
  }, {
    name: "report_task_progress",
    description: "Report a meaningful worker milestone to the owning coordinator task without ending the worker turn.",
    inputSchema: {
      workerSessionId: coordinatorIdField("Stable or local worker session id stated in the worker instructions"),
      taskId: stringField("Owned task id stated in the worker instructions"),
      activity: stringField("Short description of current work or latest milestone"),
      progress: z ? z.number().min(0).max(100).optional() : {},
    },
    handler: function (args) {
      return Promise.resolve(onReport(args || {}));
    },
  }, {
    name: "resolve_task",
    description: "Mark an owned task completed after this coordinator has independently finished and verified the requested outcome. Use this to reconcile a needs-input or failed worker result only after concrete integration and verification; it is not a substitute for worker progress.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskId: stringField("Owned task id to reconcile"),
      summary: stringField("Concrete final outcome completed by the coordinator"),
      verification: stringField("Commands, tests, or observable evidence proving the outcome is ready to test"),
      escalationRequired: z ? z.enum(["no"]).describe("Must be no; unresolved work cannot be completed") : {},
    },
    handler: function (args) {
      return Promise.resolve(onResolve(args || {}));
    },
  }, {
    name: "retry_task",
    description: "Retry a failed, blocked, or completed task while preserving its stable task identity and graph dependencies. Reuses an idle healthy worker conversation when safe; creates a fresh worker after failures, when reuse is unavailable, or when freshSession is explicitly requested for an independent pass.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      taskId: stringField("Stable task id to retry"),
      freshSession: z ? z.boolean().optional().describe("Create a clean worker conversation only when the retry requires an independent context") : {},
    },
    handler: function (args) {
      return Promise.resolve(onRetry(args || {}));
    },
  }, {
    name: "adopt_session",
    description: "Classify an existing Clay conversation offered to this coordinator. Adopt it as a new/existing task worker, retain it as context only, or mark it unrelated.",
    inputSchema: {
      coordinatorSessionId: coordinatorIdField("Stable coordinator id stated in the coordinator instructions"),
      sourceSessionId: coordinatorIdField("Stable source session id stated in the adoption handoff"),
      action: z ? z.enum(["new_task", "existing_task", "context_only", "unrelated"]) : {},
      taskId: stringField("Existing task ID when action is existing_task", true),
      title: stringField("Task title when action is new_task", true),
      objective: stringField("Owned task objective", true),
      context: stringField("Additional task context", true),
      acceptanceCriteria: stringField("Observable completion criteria", true),
      ownedPaths: stringField("Files or subsystem owned by the adopted worker", true),
      message: stringField("Instruction sent into the adopted conversation", true),
    },
    handler: function (args) {
      return Promise.resolve(onAdopt(args || {}));
    },
  }];
}

module.exports = {
  getToolDefs: getToolDefs,
};
