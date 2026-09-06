var crypto = require("crypto");
var disconnectBrowserExtension =
  require("./project-browser-extension").disconnectBrowserExtension;

var EXTENSION_HEALTH_PROBE_TIMEOUT_MS = 1000;
var EXTENSION_RECONNECT_TIMEOUT_MS = 3000;

function reconnectBrowserExtensionThroughClients(
  clients, browserState, preferredClient) {
  var requestId = "extension-reconnect-" + crypto.randomUUID();
  var requestedClients = 0;
  var requested = new Set();

  function requestReconnect(client) {
    if (!client || client.readyState !== 1 || requested.has(client)) return;
    requested.add(client);
    try {
      client.send(JSON.stringify({
        type: "extension_command",
        command: "extension_reconnect",
        args: {},
        requestId: requestId,
      }));
      requestedClients++;
    } catch (e) {}
  }

  requestReconnect(preferredClient);
  for (var client of clients) {
    requestReconnect(client);
  }
  if (requestedClients === 0) {
    return Promise.reject(new Error(
      "No connected Clay page is available to reconnect the browser extension"));
  }
  return new Promise(function (resolve, reject) {
    var startedAt = Date.now();
    function checkConnection() {
      if (browserState._extensionWs && browserState._extensionWs.readyState === 1) {
        resolve({ connected: true, requestedClients: requestedClients });
        return;
      }
      if (Date.now() - startedAt >= EXTENSION_RECONNECT_TIMEOUT_MS) {
        reject(new Error(
          "Browser extension did not reconnect after 3 seconds. Reload the Clay browser tab once, then retry."));
        return;
      }
      setTimeout(checkConnection, 50);
    }
    checkConnection();
  });
}

function requestBrowserExtensionReconnect(
  clients, browserState, sendExtensionCommandAny) {
  var extensionWs = browserState._extensionWs;
  if (!extensionWs || extensionWs.readyState !== 1) {
    return reconnectBrowserExtensionThroughClients(clients, browserState);
  }

  return Promise.resolve().then(function () {
    return sendExtensionCommandAny(
      "extension_reconnect", {}, EXTENSION_HEALTH_PROBE_TIMEOUT_MS);
  }).then(function (result) {
    if (!result || result.connected !== true) {
      throw new Error("Browser extension health probe returned no acknowledgement");
    }
    return { connected: true, requestedClients: 0 };
  }).catch(function (error) {
    disconnectBrowserExtension(
      browserState, extensionWs, "health_probe", error && error.message);
    return reconnectBrowserExtensionThroughClients(
      clients, browserState, extensionWs);
  });
}

function createProjectLocalMcpServers(ctx) {
  var defaultAdapter = ctx.adapter || null;
  var adapters = ctx.adapters || {};
  var mcpServersByAdapter = new Map();
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
  var schedulerGate = ctx.schedulerGate || null;

  function createMcpServers(adapter) {
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
          reconnectExtension: function () {
            return requestBrowserExtensionReconnect(
              clients, browserState, sendExtensionCommandAny);
          },
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

    if (!isMate && schedulerGate) {
      try {
        var schedulerMcp = require("./scheduler-mcp-server");
        var schedulerToolDefs = schedulerMcp.getToolDefs(function onSchedulerCall(action, input) {
          if (!schedulerGate.service || typeof schedulerGate.service[action] !== "function") {
            return { ok: false, code: "scheduler_unavailable", message: "The project scheduler is not ready yet." };
          }
          if (action === "list") return schedulerGate.service.list(input);
          if (action === "get") return schedulerGate.service.get(input.id);
          if (action === "create") return schedulerGate.service.create(input);
          if (action === "update") return schedulerGate.service.update(input.id, input);
          if (action === "pause") return schedulerGate.service.pause(input.id);
          if (action === "resume") return schedulerGate.service.resume(input.id);
          if (action === "runNow") return schedulerGate.service.runNow(input.id);
          if (action === "history") return schedulerGate.service.history(input.id, input.limit);
          if (action === "remove") return schedulerGate.service.remove(input.id, input.confirmName);
          return { ok: false, code: "unknown_operation", message: "Unknown scheduler operation." };
        });
        var schedulerMcpConfig = adapter.createToolServer({
          name: "clay-scheduler",
          version: "1.0.0",
          tools: schedulerToolDefs,
        });
        if (schedulerMcpConfig) {
          servers[schedulerMcpConfig.name || "clay-scheduler"] = schedulerMcpConfig;
        }
      } catch (e) {
        console.error("[project] Failed to create scheduler MCP server:", e.message);
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
        }, function onDismiss(input) {
          if (typeof taskOrchestrationGate.dismiss !== "function") {
            return { content: [{ type: "text", text: "Error: task dismissal is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.dismiss(input);
        }, function onRequestInput(input) {
          if (typeof taskOrchestrationGate.requestInput !== "function") {
            return { content: [{ type: "text", text: "Error: task input requests are not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.requestInput(input);
        }, function onSteerProjectCoordinator(input) {
          if (typeof taskOrchestrationGate.steerProjectCoordinator !== "function") {
            return { content: [{ type: "text", text: "Error: typed cross-project coordinator steering is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.steerProjectCoordinator(input);
        }, function onSwitchSessionProvider(input) {
          if (typeof taskOrchestrationGate.switchProvider !== "function") {
            return { content: [{ type: "text", text: "Error: typed cross-project provider switching is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.switchProvider(input);
        }, function onListCoopSessions(input) {
          if (typeof taskOrchestrationGate.listCoopSessions !== "function") {
            return { content: [{ type: "text", text: "Error: the Coop session ledger is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.listCoopSessions(input);
        }, function onMigrateControlPlaneBinding(input) {
          if (typeof taskOrchestrationGate.migrateControlPlaneBinding !== "function") {
            return { content: [{ type: "text", text: "Error: typed control-plane binding migration is not ready yet." }], isError: true };
          }
          return taskOrchestrationGate.migrateControlPlaneBinding(input);
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

    if (!isMate) {
      try {
        var coopLedgerMcp = require("./coop-control-ledger-reconciliation-mcp-server");
        var coopLedgerToolDefs = coopLedgerMcp.getToolDefs({ sm: sm });
        var coopLedgerMcpConfig = adapter.createToolServer({
          name: "clay-coop-control",
          version: "1.0.0",
          tools: coopLedgerToolDefs,
        });
        if (coopLedgerMcpConfig) {
          servers[coopLedgerMcpConfig.name || "clay-coop-control"] = coopLedgerMcpConfig;
        }
      } catch (e) {
        console.error("[project] Failed to create Coop ledger control MCP server:", e.message);
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
  }

  if (defaultAdapter && typeof defaultAdapter.createToolServer === "function") {
    mcpServersByAdapter.set(defaultAdapter, createMcpServers(defaultAdapter));
  }

  function getAdapterForSession(forSession) {
    if (forSession && forSession.vendor) return adapters[forSession.vendor] || null;
    return defaultAdapter;
  }

  function getLocalMcpServers(forSession) {
    var emailAvailable = !!(email && typeof email.hasEmailCapability === "function" && email.hasEmailCapability());
    var targetAdapter = getAdapterForSession(forSession);
    if (!targetAdapter || typeof targetAdapter.createToolServer !== "function") return undefined;
    if (!mcpServersByAdapter.has(targetAdapter)) {
      mcpServersByAdapter.set(targetAdapter, createMcpServers(targetAdapter));
    }
    var mcpServers = mcpServersByAdapter.get(targetAdapter);
    var availableServers = Object.assign({}, mcpServers || {});
    if (!isMate && !isHostAgent && slug === "lead") {
      var assignmentMcp = require("./coop-project-assignment-mcp");
      availableServers[assignmentMcp.SERVER_NAME] = assignmentMcp.createAssignmentServer(
        targetAdapter, sm, forSession, taskOrchestrationGate);
      var planningMcp = require("./coop-planning-mcp");
      availableServers[planningMcp.SERVER_NAME] = planningMcp.createPlanningServer(
        targetAdapter, sm, forSession, taskOrchestrationGate);
      var conversationMcp = require("./coop-owner-updates-mcp");
      availableServers[conversationMcp.SERVER_NAME] = conversationMcp.createConversationServer(targetAdapter, sm, forSession);
      var memoryMcp = require("./coop-owner-model-mcp");
      availableServers[memoryMcp.SERVER_NAME] = memoryMcp.createOwnerMemoryServer(targetAdapter, sm, forSession);
    }
    var keys = Object.keys(availableServers);
    var filtered = {};
    var hasAny = false;
    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      if (name === "clay-email" && !emailAvailable) continue;
      if (name === "clay-scheduler" && forSession && forSession.loop &&
          forSession.loop.active && forSession.loop.role !== "crafting") continue;
      filtered[name] = availableServers[name];
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
