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
    var extWs = browserState._extensionWs;
    var extConnected = !!(extWs && extWs.readyState === 1);
    var emailAvailable = !!(email && typeof email.hasEmailCapability === "function" && email.hasEmailCapability());
    var keys = Object.keys(mcpServers);
    var filtered = {};
    var hasAny = false;
    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      if (name === "clay-browser" && !extConnected) continue;
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
