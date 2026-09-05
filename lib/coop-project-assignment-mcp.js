var z = require("zod");
var plane = require("./coop-control-plane");
var fence = require("./coop-control-fence");

var SERVER_NAME = "clay-project-control";

function createAssignmentServer(adapter, manager, session, gate) {
  // Reserve the name even on anonymous discovery; remote or cached handlers
  // must never provide an alternative acceptance implementation.
  var placeholder = { name: SERVER_NAME, sessionScoped: true };
  var lease = session && session._sessionControlToolQuery;
  if (!session || !manager || !manager.sessions || manager.sessions.get(session.localId) !== session ||
      !plane.projectCoordinatorPolicy(session) || !lease || !gate) return placeholder;
  var capturedFence;
  try { capturedFence = fence.fenceFor(session); }
  catch (error) { return placeholder; }
  var schema = { taskRef: z.object({ projectId: z.literal("system-lead"),
    coordinatorSessionStorageId: z.string(), taskId: z.string() }).strict() };
  var definition = { name: "accept_project_assignment",
    description: "Accept one exact stored assignment for your bound project. Read the current project rules " +
      "and existing work first. Supply only the TaskRef; Clay resolves and rechecks its admitted scope.",
    inputSchema: schema,
    handler: function (input) {
      var result;
      try {
        if (session._deleted || !session.isProcessing || session._sessionControlToolQuery !== lease ||
            lease.signal && lease.signal.aborted || manager.sessions.get(session.localId) !== session) {
          throw new Error("Assignment caller query is no longer current");
        }
        fence.assertAction(session, "tool", capturedFence);
        if (typeof gate.acceptAssignment !== "function") throw new Error("Assignment intake unavailable");
        result = gate.acceptAssignment(session, input);
      } catch (error) { result = { ok: false, reason: error.message }; }
      return Promise.resolve(result).then(function (value) {
        return { isError: !value || value.ok !== true,
          content: [{ type: "text", text: JSON.stringify(value || { ok: false, reason: "assignment_intake_unavailable" }) }] };
      });
    } };
  var server = adapter && typeof adapter.createToolServer === "function" && adapter.createToolServer({
    name: SERVER_NAME, version: "1.0.0", tools: [definition],
  });
  if (!server) {
    // Codex uses descriptors and the per-query callback rather than an SDK
    // server instance. Keep that path usable without a Claude SDK installation.
    server = { name: SERVER_NAME, instance: { _registeredTools: {
      accept_project_assignment: Object.assign({}, definition, { inputSchema: z.object(schema).strict() }),
    } } };
  }
  server.sessionScoped = true;
  return server;
}

module.exports = { createAssignmentServer: createAssignmentServer, SERVER_NAME: SERVER_NAME };
