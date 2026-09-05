// In-app tools that require the actual calling session use the per-query
// callback. The shared project HTTP/MCP bridge cannot identify that caller.
var crypto = require("crypto");

function failure(message) {
  return { success: false, contentItems: [{ type: "inputText", text: message }] };
}

function createSessionTools(descriptors, callMcpTool) {
  var routes = Object.create(null);
  var definitions = [];
  (Array.isArray(descriptors) ? descriptors : []).forEach(function (server) {
    if (!server || server.sessionScoped !== true || typeof server.serverName !== "string") return;
    if (typeof callMcpTool !== "function") throw new Error("Session-scoped MCP callback unavailable.");
    (Array.isArray(server.tools) ? server.tools : []).forEach(function (tool) {
      if (!tool || typeof tool.name !== "string" || !tool.name) return;
      var key = server.serverName + "/" + tool.name;
      var suffix = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
      var name = "clay_" + tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40) + "_" + suffix;
      if (routes[name]) throw new Error("Duplicate session-scoped MCP tool: " + key);
      routes[name] = { server: server.serverName, tool: tool.name };
      definitions.push({ type: "function", name: name,
        description: server.serverName + "/" + tool.name + ": " + (tool.description || tool.name),
        inputSchema: tool.inputSchema || { type: "object", properties: {} } });
    });
  });

  function handles(name) {
    return typeof name === "string" && Object.prototype.hasOwnProperty.call(routes, name);
  }

  function isSessionTool(name) {
    return typeof name === "string" && /^clay_[a-zA-Z0-9_]{1,40}_[a-f0-9]{12}$/.test(name);
  }

  async function call(name, args) {
    if (!handles(name)) return failure("Session-scoped tool unavailable.");
    if (!args || typeof args !== "object" || Array.isArray(args)) return failure("Tool arguments must be an object.");
    var route = routes[name];
    try {
      var result = await callMcpTool(route.server, route.tool, args);
      // Keep the MCP envelope intact; Codex's event renderer also understands
      // images and structured content inside this JSON result.
      return { success: !!result && result.isError !== true,
        contentItems: [{ type: "inputText", text: JSON.stringify(result) || "null" }] };
    } catch (error) {
      return failure(error && error.message || "Session-scoped tool call failed.");
    }
  }

  return { dynamicTools: definitions, handles: handles, isSessionTool: isSessionTool,
    call: call, failure: failure };
}

module.exports = { createSessionTools: createSessionTools };
