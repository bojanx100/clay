var z = require("zod");
var plane = require("./coop-control-plane");
var fence = require("./coop-control-fence");
var updates = require("./coop-owner-updates");
var SERVER_NAME = "clay-coop-conversation";

function createConversationServer(adapter, manager, session) {
  var placeholder = { name: SERVER_NAME, sessionScoped: true };
  var lease = session && session._sessionControlToolQuery;
  if (!lease || plane.canonicalCoop(manager) !== session) return placeholder;
  var captured;
  try { captured = fence.fenceFor(session); } catch (error) { return placeholder; }
  function tool(name, description, schema, handler) {
    return { name: name, description: description, inputSchema: schema, handler: function (input) {
      return Promise.resolve().then(function () {
        if (session._deleted || !session.isProcessing || session._sessionControlToolQuery !== lease ||
            lease.signal && lease.signal.aborted || manager.sessions.get(session.localId) !== session ||
            plane.canonicalCoop(manager) !== session) throw new Error("conversation_caller_expired");
        fence.assertAction(session, "tool", captured);
        return handler(input || {});
      }).then(function (result) { return { isError: result.ok === false,
        content: [{ type: "text", text: JSON.stringify(result) }] }; }).catch(function (error) {
        return { isError: true, content: [{ type: "text", text: error.message }] };
      });
    } };
  }
  var defs = [tool("list_coop_feedback", "List delivered task feedback not yet included in an owner update. " +
    "Read and reconcile the referenced task evidence before reporting it.", {}, function () {
    return { ok: true, feedback: updates.pending(manager, session) };
  }), tool("publish_coop_update", "Publish one concise human-facing message to the owner in Main and the " +
    "Threads belonging to the selected feedback event IDs. Use for useful outcomes, blockers, and decisions " +
    "during automated work. Include only feedback actually discussed in this message; unrelated updates stay " +
    "in their own Threads. Pictures and Mermaid diagrams are welcome; omit code, shell commands and internal " +
    "execution commentary. Reuse replyId for an identical retry. After success the message is already visible; " +
    "do not repeat it in your internal response. Normal replies to owner messages use the ordinary chat.", {
    replyId: z.string().min(1).max(128), text: z.string().min(1).max(16000),
    feedbackEventIds: z.array(z.string().min(1).max(256)).max(32).optional(),
  }, function (input) { return updates.publish(manager, session, input); })];
  var server = adapter && adapter.createToolServer && adapter.createToolServer({
    name: SERVER_NAME, version: "1.0.0", tools: defs });
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

module.exports = { SERVER_NAME: SERVER_NAME, createConversationServer: createConversationServer };
