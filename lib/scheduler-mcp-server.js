var z;
try { z = require("zod"); } catch (e) { z = null; }

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: !!(value && value.ok === false),
  };
}

function call(onCall, action, input) {
  return Promise.resolve().then(function () {
    return onCall(action, input || {});
  }).then(result).catch(function (e) {
    return result({ ok: false, code: "scheduler_unavailable", message: e.message || String(e) });
  });
}

function idShape() {
  return z ? z.string().min(1).max(160).describe("Schedule id returned by scheduler_list or scheduler_create") : {};
}

function createShape() {
  if (!z) return {};
  return {
    name: z.string().min(1).max(100).describe("Human-readable schedule name"),
    prompt: z.string().min(1).max(50000).describe("Instructions executed in the future scheduled session"),
    cron: z.string().min(5).max(100).describe("Five-field cron expression evaluated in the Clay server timezone"),
    description: z.string().max(500).optional().describe("Short explanation shown in the scheduler"),
    judge: z.string().max(50000).optional().describe("Optional judge instructions. Omit for a single-pass simple task"),
    timezone: z.string().max(100).optional().describe("Optional IANA timezone. Currently must match the Clay server timezone"),
    enabled: z.boolean().optional().describe("Whether the schedule starts active. Defaults to true"),
    maxIterations: z.number().int().min(1).max(100).optional().describe("Maximum task iterations. Defaults to 1"),
    skipIfRunning: z.boolean().optional().describe("Skip an occurrence when another loop is active. Defaults to true"),
    idempotencyKey: z.string().min(1).max(128).optional().describe("Stable caller key that makes repeated create calls return the same schedule"),
    model: z.string().min(1).max(100).optional().describe("Optional model id for scheduled sessions"),
    permissionMode: z.enum(["default", "plan", "acceptEdits", "bypassPermissions"]).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultracode", "ultra", "sol"]).optional(),
    thinking: z.enum(["disabled", "adaptive", "budget"]).optional(),
    thinkingBudget: z.number().int().min(1024).max(128000).optional(),
  };
}

function updateShape() {
  if (!z) return {};
  return Object.assign({
    id: idShape(),
    expectedUpdatedAt: z.number().int().optional().describe("Optional optimistic concurrency value from scheduler_get"),
  }, createShape(), {
    name: z.string().min(1).max(100).optional(),
    prompt: z.string().min(1).max(50000).optional(),
    cron: z.string().min(5).max(100).optional(),
  });
}

function getToolDefs(onCall) {
  if (typeof onCall !== "function") throw new Error("scheduler MCP requires an operation handler");
  return [{
    name: "scheduler_list",
    description: "List scheduled tasks in the current Clay project. Read-only. Returns the Clay server timezone and persisted run state.",
    inputSchema: z ? {
      enabledOnly: z.boolean().optional().describe("Return only enabled schedules"),
    } : {},
    handler: function (input) { return call(onCall, "list", input); },
  }, {
    name: "scheduler_get",
    description: "Read one scheduled task, including its prompt, optional judge, model settings, timing, and recent state. Read-only.",
    inputSchema: { id: idShape() },
    handler: function (input) { return call(onCall, "get", input); },
  }, {
    name: "scheduler_create",
    description: "Create a recurring scheduled task in the current Clay project. Use an idempotency key so retries cannot create duplicates. This changes persistent scheduler state.",
    inputSchema: createShape(),
    handler: function (input) { return call(onCall, "create", input); },
  }, {
    name: "scheduler_update",
    description: "Update a scheduled task in the current Clay project. Only supplied fields change. Pass expectedUpdatedAt to avoid overwriting concurrent edits.",
    inputSchema: updateShape(),
    handler: function (input) { return call(onCall, "update", input); },
  }, {
    name: "scheduler_pause",
    description: "Pause a scheduled task without deleting its definition or history.",
    inputSchema: { id: idShape() },
    handler: function (input) { return call(onCall, "pause", input); },
  }, {
    name: "scheduler_resume",
    description: "Resume a paused scheduled task and calculate its next run time.",
    inputSchema: { id: idShape() },
    handler: function (input) { return call(onCall, "resume", input); },
  }, {
    name: "scheduler_run_now",
    description: "Start a scheduled task immediately if no other loop is active. The recurring schedule remains unchanged.",
    inputSchema: { id: idShape() },
    handler: function (input) { return call(onCall, "runNow", input); },
  }, {
    name: "scheduler_history",
    description: "Read recent execution history for one scheduled task. Read-only; Clay retains at most 20 runs.",
    inputSchema: z ? {
      id: idShape(),
      limit: z.number().int().min(1).max(20).optional(),
    } : { id: {} },
    handler: function (input) { return call(onCall, "history", input); },
  }, {
    name: "scheduler_delete",
    description: "Delete a schedule record while retaining its prompt files for recovery. confirmName must exactly match the current name.",
    inputSchema: z ? {
      id: idShape(),
      confirmName: z.string().min(1).max(100).describe("Exact current schedule name, obtained from scheduler_get"),
    } : { id: {}, confirmName: {} },
    handler: function (input) { return call(onCall, "remove", input); },
  }];
}

module.exports = {
  getToolDefs: getToolDefs,
};
