var crypto = require("crypto");

function createProjectLocalMcpServers(ctx) {
  var adapter = ctx.adapter;
  var isMate = !!ctx.isMate;
  var isHostAgent = !!ctx.isHostAgent;
  var slug = ctx.slug;
  var sm = ctx.sm;
  var clients = ctx.clients;
  var browserState = ctx.browserState;
  var sendExtensionCommandAny = ctx.sendExtensionCommandAny;
  var loadContextSources = ctx.loadContextSources;
  var saveContextSources = ctx.saveContextSources;
  var getAllProjectsWithSessions = ctx.getAllProjectsWithSessions;
  var pendingDebateProposals = ctx.pendingDebateProposals;
  var email = ctx.email;
  var mateDatastore = ctx.mateDatastore;
  var providerSwitchGate = ctx.providerSwitchGate || null;
  var taskOrchestrationGate = ctx.taskOrchestrationGate || null;

  var mcpServers = (function () {
    var servers = {};

    try {
      var debateMcp = require("./debate-mcp-server");
      var debateToolDefs = debateMcp.getToolDefs(function onPropose(briefData) {
        return new Promise(function (resolve) {
          var proposalId = "dp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
          briefData.proposalId = proposalId;
          pendingDebateProposals[proposalId] = {
            resolve: resolve,
            briefData: briefData,
          };
        });
      });
      var debateMcpConfig = adapter.createToolServer({ name: "clay-debate", version: "1.0.0", tools: debateToolDefs });
      if (debateMcpConfig) servers[debateMcpConfig.name || "clay-debate"] = debateMcpConfig;
    } catch (e) {
      console.error("[project] Failed to create debate MCP server:", e.message);
    }

    if (isHostAgent) {
      try {
        var clayHistoryMcp = require("./clay-history-mcp-server");
        var clayHistoryToolDefs = clayHistoryMcp.getToolDefs({
          getAllProjectsWithSessions: getAllProjectsWithSessions,
        });
        var clayHistoryMcpConfig = adapter.createToolServer({ name: "clay-history", version: "1.0.0", tools: clayHistoryToolDefs });
        if (clayHistoryMcpConfig) servers[clayHistoryMcpConfig.name || "clay-history"] = clayHistoryMcpConfig;
      } catch (e) {
        console.error("[project] Failed to create clay-history MCP server:", e.message);
      }
    }

    if (isMate) {
      try {
        var askUserMcp = require("./ask-user-mcp-server");
        var askUserToolDefs = askUserMcp.getToolDefs(function onAsk(input) {
          var session = sm.getActiveSession();
          if (!session) {
            return Promise.resolve({
              content: [{ type: "text", text: "Error: no active session in " + slug + "; cannot display question card." }],
              isError: true,
            });
          }
          if (session.loop && session.loop.active && session.loop.role !== "crafting") {
            return Promise.resolve({
              content: [{ type: "text", text: "Error: Autonomous mode. Make your own decision." }],
              isError: true,
            });
          }

          var toolId = "ask_" + Date.now() + "_" + crypto.randomUUID().slice(0, 8);
          session.pendingAskUser[toolId] = {
            input: input,
            mode: "mcp",
            sessionId: session.localId,
            postedAt: Date.now(),
          };

          sm.sendAndRecord(session, {
            type: "tool_executing",
            id: toolId,
            name: "AskUserQuestion",
            input: input,
          });

          return Promise.resolve({
            content: [{
              type: "text",
              text: "The question card has been posted to the user. End this turn now without further commentary; the user's answer will arrive as the next user message, prefixed with \"[Answer to your AskUserQuestion]\" so you can recognize it.",
            }],
          });
        });
        var askUserMcpConfig = adapter.createToolServer({ name: "clay-ask-user", version: "1.0.0", tools: askUserToolDefs });
        if (askUserMcpConfig) servers[askUserMcpConfig.name || "clay-ask-user"] = askUserMcpConfig;
      } catch (e) {
        console.error("[project] Failed to create ask-user MCP server:", e.message);
      }
    }

    if (!isMate) {
      try {
        var browserMcp = require("./browser-mcp-server");
        var browserToolDefs = browserMcp.getToolDefs(sendExtensionCommandAny, function () {
          var extensionWs = browserState._extensionWs;
          if (!extensionWs || extensionWs.readyState !== 1) {
            throw new Error("Browser extension not connected");
          }
          return Object.values(browserState._browserTabList || {});
        }, {
          watchTab: function (tabId) {
            var key = "tab:" + tabId;
            for (var c of clients) {
              if (c.readyState !== 1) continue;
              var sid = c._clayActiveSession || null;
              var active = loadContextSources(slug, sid);
              if (active.indexOf(key) === -1) {
                active.push(key);
                saveContextSources(slug, sid, active);
                c.send(JSON.stringify({ type: "context_sources_state", active: active }));
              }
            }
            return [];
          },
          unwatchTab: function (tabId) {
            var key = "tab:" + tabId;
            for (var c of clients) {
              if (c.readyState !== 1) continue;
              var sid = c._clayActiveSession || null;
              var active = loadContextSources(slug, sid);
              var idx = active.indexOf(key);
              if (idx !== -1) {
                active.splice(idx, 1);
                saveContextSources(slug, sid, active);
                c.send(JSON.stringify({ type: "context_sources_state", active: active }));
              }
            }
            return active;
          },
        });
        var mcpConfig = adapter.createToolServer({ name: "clay-browser", version: "1.0.0", tools: browserToolDefs });
        if (mcpConfig) servers[mcpConfig.name || "clay-browser"] = mcpConfig;
      } catch (e) {
        console.error("[project] Failed to create browser MCP server:", e.message);
      }
    }

    try {
      var emailMcp = require("./email-mcp-server");
      var emailMcpConfig = emailMcp.create(email.createMcpDeps());
      if (emailMcpConfig) servers[emailMcpConfig.name || "clay-email"] = emailMcpConfig;
    } catch (e) {
      console.error("[project] Failed to create email MCP server:", e.message);
    }

    if (providerSwitchGate) {
      try {
        var switchProviderMcp = require("./switch-provider-mcp-server");
        // Late binding: the gate handler is attached by project.js AFTER the
        // runtime exists, so read it at call time, not registration time.
        var switchProviderToolDefs = switchProviderMcp.getToolDefs(function onRequest(input) {
          if (typeof providerSwitchGate.handler !== "function") {
            return {
              content: [{ type: "text", text: "Error: provider switching is not ready yet in this project." }],
              isError: true,
            };
          }
          return providerSwitchGate.handler(input);
        });
        var switchProviderMcpConfig = adapter.createToolServer({ name: "clay-provider", version: "1.0.0", tools: switchProviderToolDefs });
        if (switchProviderMcpConfig) servers[switchProviderMcpConfig.name || "clay-provider"] = switchProviderMcpConfig;
      } catch (e) {
        console.error("[project] Failed to create switch-provider MCP server:", e.message);
      }
    }

    if (!isMate && taskOrchestrationGate) {
      try {
        var orchestrationMcp = require("./orchestration-mcp-server");
        var orchestrationToolDefs = orchestrationMcp.getToolDefs(function onDelegate(input) {
          if (typeof taskOrchestrationGate.delegate !== "function") {
            return {
              content: [{ type: "text", text: "Error: task orchestration is not ready yet in this project." }],
              isError: true,
            };
          }
          return taskOrchestrationGate.delegate(input);
        }, function onMessage(input) {
          if (typeof taskOrchestrationGate.message !== "function") {
            return {
              content: [{ type: "text", text: "Error: task orchestration is not ready yet in this project." }],
              isError: true,
            };
          }
          return taskOrchestrationGate.message(input);
        }, function onPlan(input) {
          if (typeof taskOrchestrationGate.plan !== "function") {
            return { content: [{ type: "text", text: "Error: task graph planning is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.plan(input);
        }, function onReport(input) {
          if (typeof taskOrchestrationGate.report !== "function") {
            return { content: [{ type: "text", text: "Error: task progress reporting is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.report(input);
        }, function onRetry(input) {
          if (typeof taskOrchestrationGate.retry !== "function") {
            return { content: [{ type: "text", text: "Error: task retry is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.retry(input);
        }, function onAdopt(input) {
          if (typeof taskOrchestrationGate.adopt !== "function") {
            return { content: [{ type: "text", text: "Error: session adoption is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.adopt(input);
        }, function onResolve(input) {
          if (typeof taskOrchestrationGate.resolve !== "function") {
            return { content: [{ type: "text", text: "Error: task resolution is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.resolve(input);
        });
        var orchestrationMcpConfig = adapter.createToolServer({
          name: "clay-orchestration",
          version: "1.0.0",
          tools: orchestrationToolDefs,
        });
        if (orchestrationMcpConfig) {
          servers[orchestrationMcpConfig.name || "clay-orchestration"] = orchestrationMcpConfig;
        }
      } catch (e) {
        console.error("[project] Failed to create orchestration MCP server:", e.message);
      }
    }

    if (isMate) {
      try {
        var datastoreMcp = mateDatastore.createMcpServer();
        if (datastoreMcp) servers[datastoreMcp.name || "clay-datastore"] = datastoreMcp;
      } catch (e) {
        console.error("[project] Failed to create datastore MCP server:", e.message);
      }
    }

    return Object.keys(servers).length > 0 ? servers : undefined;
  })();

  function getLocalMcpServers() {
    if (!mcpServers) return undefined;
    var emailAvailable = !!(email && typeof email.hasEmailCapability === "function" && email.hasEmailCapability());
    var keys = Object.keys(mcpServers);
    var filtered = {};
    var hasAny = false;
    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      if (name === "clay-email" && !emailAvailable) continue;
      filtered[name] = mcpServers[name];
      hasAny = true;
    }
    return hasAny ? filtered : undefined;
  }

  return {
    getLocalMcpServers: getLocalMcpServers,
  };
}

module.exports = {
  createProjectLocalMcpServers: createProjectLocalMcpServers,
};
