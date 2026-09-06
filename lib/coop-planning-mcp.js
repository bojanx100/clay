var z = require("zod");
var plane = require("./coop-control-plane");
var fence = require("./coop-control-fence");
var SERVER_NAME = "clay-coop-planning";

function createPlanningServer(adapter, manager, session, gate) {
  var placeholder = { name: SERVER_NAME, sessionScoped: true };
  var lease = session && session._sessionControlToolQuery;
  if (!lease || !gate || plane.canonicalCoop(manager) !== session) return placeholder;
  var capturedFence;
  try { capturedFence = fence.fenceFor(session); } catch (error) { return placeholder; }
  function tool(name, description, schema, method) {
    return { name: name, description: description, inputSchema: schema,
      handler: function (input) {
        return Promise.resolve().then(function () {
          if (session._deleted || !session.isProcessing || session._sessionControlToolQuery !== lease ||
              lease.signal && lease.signal.aborted || manager.sessions.get(session.localId) !== session ||
              plane.canonicalCoop(manager) !== session) throw new Error("planning_caller_query_expired");
          fence.assertAction(session, "tool", capturedFence);
          if (!gate.planning || typeof gate.planning[method] !== "function") throw new Error("planning_unavailable");
          return gate.planning[method](session, input || {});
        }).then(function (value) {
          if (value && Array.isArray(value.content)) return value;
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        }).catch(function (error) {
          return { isError: true, content: [{ type: "text", text: error.message }] };
        });
      } };
  }
  var defs = [tool("list_planning_participants", "List actual available Mates for a Council or Triage debate in Coop.", {}, "participants"),
    tool("start_coop_planning", "Start an idempotent multi-AI Council or Triage discussion in Coop's existing Thread. " +
      "It creates no project execution. The owner can join the visible debate. Results return to Coop for " +
      "judgment and separately authorized commissioning. Use this instead of delegate_task for Council/Triage.", {
      requestId: z.string(), kind: z.enum(["council", "triage"]),
      topicRef: z.object({ topicId: z.string() }).strict(), question: z.string(), context: z.string().optional(),
      moderatorId: z.string(), panelists: z.array(z.object({ mateId: z.string(),
        role: z.string(), brief: z.string() }).strict()).min(2).max(4),
    }, "start"),
    tool("read_coop_planning", "Read the durable status, debate contributions and synthesis of an exact planning request.",
      { requestId: z.string() }, "inspect"),
    tool("commission_coop_plan", "Commission an exact completed planning synthesis to the resident project " +
      "coordinator using the ordinary authorization and assignment checks. Review unresolved choices first; " +
      "planning itself is not permission. Retries must retain identical scope and binding identifiers.", {
      requestId: z.string(), planDigest: z.string(), targetProject: z.object({ projectId: z.string() }).strict(),
      portfolioTaskId: z.string(), bindingRevision: z.number().int().min(1), idempotencyKey: z.string(),
      implementationGrantRef: z.string().optional(), acceptanceCriteria: z.string(), ownedPaths: z.string(),
    }, "commission")];
  var server = adapter && adapter.createToolServer && adapter.createToolServer({
    name: SERVER_NAME, version: "1.0.0", tools: defs,
  });
  if (!server) {
    var registered = {};
    defs.forEach(function (definition) {
      registered[definition.name] = Object.assign({}, definition, { inputSchema: z.object(definition.inputSchema).strict() });
    });
    server = { name: SERVER_NAME, instance: { _registeredTools: registered } };
  }
  server.sessionScoped = true;
  return server;
}

module.exports = { createPlanningServer: createPlanningServer, SERVER_NAME: SERVER_NAME };
