var test = require("node:test");
var assert = require("node:assert");
var events = require("events");
var stream = require("stream");

var entitlements = require("../lib/yoke/adapters/github-copilot-entitlements");
var providerRoutes = require("../lib/provider-routes");

function makeFakeProcess() {
  var proc = new events.EventEmitter();
  proc.stdout = new stream.PassThrough();
  proc.stdin = new stream.PassThrough();
  proc.stderr = new stream.PassThrough();
  proc.killed = false;
  proc.kill = function() {
    proc.killed = true;
    return true;
  };
  return proc;
}

function makeAcpLoader(connection) {
  return function() {
    return Promise.resolve({
      PROTOCOL_VERSION: 1,
      ndJsonStream: function() { return {}; },
      ClientSideConnection: function() { return connection; },
    });
  };
}

test("Copilot entitlement discovery reads the account-scoped ACP model option", async function() {
  entitlements._test.reset();
  var closedSessionId = null;
  var newSessionParams = null;
  var connection = {
    initialize: function() { return Promise.resolve({ agentCapabilities: {} }); },
    newSession: function(params) {
      newSessionParams = params;
      return Promise.resolve({
        sessionId: "discovery-session",
        configOptions: [{
          id: "model",
          category: "model",
          currentValue: "claude-sonnet-5",
          options: [
            { value: "auto" },
            { name: "Claude", options: [{ value: "claude-sonnet-5" }, { value: "claude-fable-5" }] },
            { name: "OpenAI", options: [{ value: "gpt-5.5" }] },
          ],
        }],
      });
    },
    closeSession: function(params) {
      closedSessionId = params.sessionId;
      return Promise.resolve({});
    },
  };
  var proc = makeFakeProcess();
  var snapshot = await entitlements.probeCopilotEntitlements({
    executable: "/bin/copilot",
    cwd: process.cwd(),
    acpLoader: makeAcpLoader(connection),
    spawn: function() { return proc; },
  });

  assert.deepStrictEqual(snapshot.models, ["claude-sonnet-5", "auto", "claude-fable-5", "gpt-5.5"]);
  assert.strictEqual(snapshot.defaultModel, "claude-sonnet-5");
  assert.strictEqual(snapshot.source, "acp-config");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(newSessionParams, "mcpServers"), false);
  assert.strictEqual(closedSessionId, "discovery-session");
  assert.strictEqual(proc.killed, true);
});

test("Copilot entitlement discovery preserves supplied ACP MCP servers", async function() {
  entitlements._test.reset();
  var newSessionParams = null;
  var mcpServers = [{ name: "clay-tools", command: process.execPath, args: ["bridge.js"], env: { CLAY_AUTH_TOKEN: "token" } }];
  var connection = {
    initialize: function() { return Promise.resolve({ agentCapabilities: {} }); },
    newSession: function(params) {
      newSessionParams = params;
      return Promise.resolve({
        sessionId: "discovery-session",
        configOptions: [{
          id: "model",
          category: "model",
          currentValue: "auto",
          options: [{ value: "auto" }],
        }],
      });
    },
    closeSession: function() {
      return Promise.resolve({});
    },
  };
  var proc = makeFakeProcess();

  await entitlements.probeCopilotEntitlements({
    executable: "/bin/copilot",
    cwd: process.cwd(),
    mcpServers: mcpServers,
    acpLoader: makeAcpLoader(connection),
    spawn: function() { return proc; },
  });

  assert.deepStrictEqual(newSessionParams.mcpServers, mcpServers);
  assert.strictEqual(proc.killed, true);
});

test("trusted Copilot catalogs expire when refresh has been failing", function() {
  entitlements._test.reset();
  entitlements._test.setSnapshot(["claude-fable-5"], Date.now() - entitlements._test.TRUST_TTL_MS - 1);
  assert.strictEqual(entitlements.hasTrustedCopilotEntitlements(), false);
  entitlements._test.setSnapshot(["claude-fable-5"], Date.now());
  assert.strictEqual(entitlements.hasTrustedCopilotEntitlements(), true);
  entitlements._test.setError();
  assert.strictEqual(entitlements.hasTrustedCopilotEntitlements(), false);
  entitlements._test.reset();
});

test("live Copilot models replace static guesses for provider consumers", function() {
  entitlements._test.reset();
  entitlements._test.setSnapshot(["auto", "claude-sonnet-5", "claude-fable-5"]);
  var models = providerRoutes.knownModelsForProvider("github-copilot");
  assert.deepStrictEqual(models, ["auto", "claude-sonnet-5", "claude-fable-5"]);
  assert.strictEqual(models.indexOf("gpt-5.2"), -1);
  assert.strictEqual(providerRoutes.hasLiveModelsForProvider("github-copilot"), true);
  entitlements._test.reset();
});
