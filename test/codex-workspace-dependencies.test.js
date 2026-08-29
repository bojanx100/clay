var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var codexAdapter = require("../lib/yoke/adapters/codex");
var workspaceDependencies = require("../lib/yoke/adapters/codex-workspace-dependencies");

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "runtime fixture\n");
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o755);
}

function createRuntimeFixture(overrides) {
  var tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clay-codex-runtime-"));
  var runtimeRoot = path.join(tempRoot, "codex-primary-runtime");
  var dependenciesRoot = path.join(runtimeRoot, "dependencies");
  var pythonVersion = "3.12.13";
  var nodePath = process.platform === "win32"
    ? path.join(dependenciesRoot, "node", "node.exe")
    : path.join(dependenciesRoot, "node", "bin", "node");
  var pythonPath = process.platform === "win32"
    ? path.join(dependenciesRoot, "python", "python.exe")
    : path.join(dependenciesRoot, "python", "bin", "python");
  var pythonLibrariesPath = process.platform === "win32"
    ? path.join(dependenciesRoot, "python", "Lib", "site-packages")
    : path.join(dependenciesRoot, "python", "lib", "python3.12", "site-packages");
  var metadata = Object.assign({
    artifactToolVersion: "2.8.43",
    bundleFormatVersion: 2,
    bundleVersion: "26.813.12317",
    nodeVersion: "v24.19.0",
    pythonVersion: pythonVersion,
    targetArch: process.arch,
    targetPlatform: process.platform,
  }, overrides || {});

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "runtime.json"), JSON.stringify(metadata));
  writeExecutable(nodePath);
  writeExecutable(pythonPath);
  fs.mkdirSync(path.join(dependenciesRoot, "node", "node_modules", "@oai", "artifact-tool"), { recursive: true });
  fs.mkdirSync(pythonLibrariesPath, { recursive: true });
  fs.mkdirSync(path.join(dependenciesRoot, "bin", "override"), { recursive: true });
  fs.mkdirSync(path.join(dependenciesRoot, "bin", "fallback"), { recursive: true });

  return {
    root: runtimeRoot,
    nodePath: nodePath,
    nodeModulesPath: path.join(dependenciesRoot, "node", "node_modules"),
    pythonPath: pythonPath,
    pythonLibrariesPath: pythonLibrariesPath,
    overrideBinPath: path.join(dependenciesRoot, "bin", "override"),
    fallbackBinPath: path.join(dependenciesRoot, "bin", "fallback"),
    cleanup: function() {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function featureServer(enabled) {
  return {
    send: function(method) {
      assert.strictEqual(method, "experimentalFeature/list");
      return Promise.resolve({
        data: [{ name: "workspace_dependencies", enabled: enabled }],
        nextCursor: null,
      });
    },
  };
}

function createQueryServer(responsePromiseResolve) {
  var handler = null;
  var calls = [];
  return {
    started: true,
    calls: calls,
    subscribe: function(nextHandler) {
      handler = nextHandler;
      return function() { handler = null; };
    },
    send: function(method, params) {
      calls.push({ method: method, params: params });
      if (method === "thread/start") {
        return Promise.resolve({ thread: { id: "workspace-thread" } });
      }
      if (method === "thread/resume") {
        return Promise.resolve({ thread: { id: params.threadId } });
      }
      if (method === "turn/start") {
        setImmediate(function() {
          if (!handler) return;
          handler({
            jsonrpc: "2.0",
            id: 91,
            method: "item/tool/call",
            params: {
              threadId: params.threadId,
              turnId: "workspace-turn",
              callId: "workspace-call",
              tool: "load_workspace_dependencies",
              arguments: {},
            },
          });
          setImmediate(function() {
            if (!handler) return;
            handler({
              method: "turn/completed",
              params: {
                threadId: params.threadId,
                turn: { id: "workspace-turn", status: "completed", items: [] },
              },
            });
          });
        });
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
    respond: function(id, result) {
      responsePromiseResolve({ id: id, result: result });
    },
  };
}

test("workspace dependency support exposes the exact Codex dynamic tool", async function(t) {
  var fixture = createRuntimeFixture();
  t.after(fixture.cleanup);

  var support = await workspaceDependencies.createWorkspaceDependenciesSupport({
    appServer: featureServer(true),
    runtimeRoot: fixture.root,
  });

  assert.strictEqual(support.enabled, true);
  assert.deepStrictEqual(support.dynamicTools, [{
    type: "function",
    name: "load_workspace_dependencies",
    description: "Locate the configured bundled workspace dependency runtime paths for this local Clay Codex thread, including Node.js, Python, and useful libraries for working with spreadsheets, slide decks, Word documents, and PDFs. This is read-only and takes no arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }]);

  var response = await support.handleCall({});
  assert.strictEqual(response.success, true);
  assert.match(response.contentItems[0].text, /Workspace dependencies are available/);
  assert.match(response.contentItems[0].text, new RegExp(fixture.nodeModulesPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(response.contentItems[0].text, new RegExp(fixture.pythonLibrariesPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  var invalidResponse = await support.handleCall({ unexpected: true });
  assert.strictEqual(invalidResponse.success, false);
  assert.match(invalidResponse.contentItems[0].text, /takes no arguments/);
});

test("workspace dependency support fails closed when the feature is disabled", async function(t) {
  var fixture = createRuntimeFixture();
  t.after(fixture.cleanup);

  var support = await workspaceDependencies.createWorkspaceDependenciesSupport({
    appServer: featureServer(false),
    runtimeRoot: fixture.root,
  });

  assert.strictEqual(support.enabled, false);
  assert.deepStrictEqual(support.dynamicTools, []);
  assert.match(support.reason, /disabled/);
});

test("workspace dependency support rejects an incompatible runtime bundle", async function(t) {
  var fixture = createRuntimeFixture({ targetArch: "incompatible-architecture" });
  t.after(fixture.cleanup);

  var support = await workspaceDependencies.createWorkspaceDependenciesSupport({
    appServer: featureServer(true),
    runtimeRoot: fixture.root,
  });

  assert.strictEqual(support.enabled, false);
  assert.deepStrictEqual(support.dynamicTools, []);
  assert.match(support.reason, /architecture/);
});

test("Codex query registers and answers the workspace dependency dynamic tool", async function(t) {
  var fixture = createRuntimeFixture();
  t.after(fixture.cleanup);
  var support = await workspaceDependencies.createWorkspaceDependenciesSupport({
    appServer: featureServer(true),
    runtimeRoot: fixture.root,
  });
  var resolveResponse;
  var responsePromise = new Promise(function(resolve) { resolveResponse = resolve; });
  var server = createQueryServer(resolveResponse);
  var handle = codexAdapter.contractTestKit.createQueryHandle(server, {
    cwd: process.cwd(),
    model: "gpt-5.6-sol",
    systemPrompt: "Project instructions",
    workspaceDependencies: support,
    abortController: new AbortController(),
  });
  t.after(function() { handle.close(); });

  await handle.setModel("gpt-5.6-terra");
  handle.pushMessage("Create a workbook");
  var response = await responsePromise;
  var threadStart = server.calls.find(function(call) { return call.method === "thread/start"; });
  var turnStart = server.calls.find(function(call) { return call.method === "turn/start"; });

  assert.deepStrictEqual(threadStart.params.dynamicTools, support.dynamicTools);
  assert.strictEqual(turnStart.params.model, "gpt-5.6-terra");
  assert.match(turnStart.params.input[0].text, /call `load_workspace_dependencies`/);
  assert.strictEqual(response.id, 91);
  assert.strictEqual(response.result.success, true);
});

test("Codex resume explicitly clears unavailable workspace dependency tools", async function() {
  var resolveResponse;
  var responsePromise = new Promise(function(resolve) { resolveResponse = resolve; });
  var server = createQueryServer(resolveResponse);
  var support = workspaceDependencies.createDisabledSupport("runtime unavailable");
  var handle = codexAdapter.contractTestKit.createQueryHandle(server, {
    cwd: process.cwd(),
    model: "gpt-5.6-sol",
    resumeSessionId: "resumed-thread",
    workspaceDependencies: support,
    abortController: new AbortController(),
  });

  handle.pushMessage("Continue");
  await responsePromise;
  handle.close();
  var threadResume = server.calls.find(function(call) { return call.method === "thread/resume"; });

  assert.deepStrictEqual(threadResume.params.dynamicTools, []);
});
