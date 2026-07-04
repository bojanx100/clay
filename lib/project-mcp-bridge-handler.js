function createMcpBridgeHandlerFactory(ctx) {
  var getLocalMcpServers = ctx.getLocalMcpServers;
  var getRemoteMcpServers = ctx.getRemoteMcpServers;

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

        function extractServerTools(serverName, server) {
          if (!server || !server.instance || !server.instance._registeredTools) return;
          var toolNames = Object.keys(server.instance._registeredTools);
          for (var j = 0; j < toolNames.length; j++) {
            var toolDef = server.instance._registeredTools[toolNames[j]];
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
            extractServerTools(inAppNames[i], localMcp[inAppNames[i]]);
          }
        }

        var remoteServers = getRemoteMcpServers();
        if (remoteServers) {
          var remoteNames = Object.keys(remoteServers);
          for (var ri = 0; ri < remoteNames.length; ri++) {
            if (localMcpNames[remoteNames[ri]]) continue;
            extractServerTools(remoteNames[ri], remoteServers[remoteNames[ri]]);
          }
        }

        return Promise.resolve(tools);
      },
      callTool: function (serverName, toolName, args) {
        var localMcp = getLocalMcpServers();
        if (localMcp && localMcp[serverName]) {
          var server = localMcp[serverName];
          if (server.instance && server.instance._registeredTools && server.instance._registeredTools[toolName]) {
            var handler = server.instance._registeredTools[toolName].handler;
            if (typeof handler === "function") {
              return Promise.resolve(handler(args));
            }
          }
        }

        var remoteServers = getRemoteMcpServers();
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
