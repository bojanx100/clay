function createMcpBridgeHandlerFactory(ctx) {
  var getLocalMcpServers = ctx.getLocalMcpServers;
  var getRemoteMcpServers = ctx.getRemoteMcpServers;
  var advertisedLocalTools = {};
  var sessionScopedServers = {};

  function requiresSession(name, server) {
    if (server && server.sessionScoped === true) {
      sessionScopedServers[name] = true;
      delete advertisedLocalTools[name];
    }
    return sessionScopedServers[name] === true;
  }

  function getMcpBridgeHandler() {
    var localMcpNames = {};
    try {
      var mcpLocalModule = require("./mcp-local");
      var localConfig = mcpLocalModule.readMergedServers();
      var lcNames = Object.keys(localConfig);
      for (var li = 0; li < lcNames.length; li++) {
        localMcpNames[lcNames[li]] = true;
      }
    } catch (e) { /* no local MCP config */ }

    return {
      listTools: function () {
        var tools = [];
        var toJSONSchema;
        try { toJSONSchema = require("zod").toJSONSchema; } catch (e) { /* fallback */ }

        function extractServerTools(serverName, server, rememberLocal) {
          if (requiresSession(serverName, server)) return;
          if (!server || !server.instance || !server.instance._registeredTools) return;
          var toolNames = Object.keys(server.instance._registeredTools);
          if (rememberLocal && !advertisedLocalTools[serverName]) advertisedLocalTools[serverName] = {};
          for (var j = 0; j < toolNames.length; j++) {
            var toolDef = server.instance._registeredTools[toolNames[j]];
            if (rememberLocal) advertisedLocalTools[serverName][toolNames[j]] = toolDef;
            var inputSchema = { type: "object", properties: {} };
            try {
              if (toJSONSchema && toolDef.inputSchema) inputSchema = toJSONSchema(toolDef.inputSchema);
            } catch (e) { /* fallback */ }
            tools.push({
              server: serverName,
              name: toolNames[j],
              description: toolDef.description || toolNames[j],
              inputSchema: inputSchema,
            });
          }
        }

        var localMcp = getLocalMcpServers();
        if (localMcp) {
          var inAppNames = Object.keys(localMcp);
          for (var i = 0; i < inAppNames.length; i++) {
            extractServerTools(inAppNames[i], localMcp[inAppNames[i]], true);
          }
        }

        var remoteServers = getRemoteMcpServers();
        if (remoteServers) {
          var remoteNames = Object.keys(remoteServers);
          for (var ri = 0; ri < remoteNames.length; ri++) {
            if (localMcpNames[remoteNames[ri]]) continue;
            extractServerTools(remoteNames[ri], remoteServers[remoteNames[ri]], false);
          }
        }

        return Promise.resolve(tools);
      },
      callTool: function (serverName, toolName, args) {
        var localMcp = getLocalMcpServers();
        var remoteServers = getRemoteMcpServers();
        if (requiresSession(serverName, localMcp && localMcp[serverName]) ||
            requiresSession(serverName, remoteServers && remoteServers[serverName])) {
          return Promise.reject(new Error("Session-scoped tool requires a calling session."));
        }
        if (localMcp && localMcp[serverName]) {
          var server = localMcp[serverName];
          if (server.instance && server.instance._registeredTools && server.instance._registeredTools[toolName]) {
            var handler = server.instance._registeredTools[toolName].handler;
            if (typeof handler === "function") {
              return Promise.resolve(handler(args));
            }
          }
        }

        // A local capability can disappear between tools/list and tools/call
        // when its backing connection drops. Preserve tools already advertised
        // to the active agent turn so their handlers can return the real
        // connection error instead of the misleading "Tool not found".
        var advertisedServer = advertisedLocalTools[serverName];
        if (advertisedServer && advertisedServer[toolName]) {
          var advertisedHandler = advertisedServer[toolName].handler;
          if (typeof advertisedHandler === "function") {
            return Promise.resolve(advertisedHandler(args));
          }
        }

        if (remoteServers && remoteServers[serverName]) {
          var rServer = remoteServers[serverName];
          if (rServer.instance && rServer.instance._registeredTools && rServer.instance._registeredTools[toolName]) {
            var rHandler = rServer.instance._registeredTools[toolName].handler;
            if (typeof rHandler === "function") {
              return Promise.resolve(rHandler(args));
            }
          }
        }
        return Promise.reject(new Error("Tool not found: " + serverName + "/" + toolName));
      },
    };
  }

  return getMcpBridgeHandler;
}

module.exports = {
  createMcpBridgeHandlerFactory: createMcpBridgeHandlerFactory,
};
