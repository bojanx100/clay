// Local protocol fixture: the real installed binary talks only to a localhost
// fake model and harmless MCP server. Credentials and native state are isolated.
var fs = require("fs");
var path = require("path");
var http = require("http");
var home = require("./isolated-clay-home");
var nativeModule = require("../../lib/yoke/codex-app-server");
var createHandle = require("../../lib/yoke/adapters/codex").contractTestKit.createQueryHandle;

function event(type, fields) {
  return "event: " + type + "\ndata: " + JSON.stringify(Object.assign({ type: type }, fields)) + "\n\n";
}

async function fixture(t) {
  var binary;
  try { binary = nativeModule.findCodexPath(); } catch (error) { t.skip("Optional Codex binary is not installed"); return; }
  var dir = fs.mkdtempSync(path.join(home, "native-readonly-"));
  var requests = [];
  var command = "";
  var native;
  var handles = [];
  var server = http.createServer(function (req, res) {
    var chunks = [];
    req.on("data", function (chunk) { chunks.push(chunk); });
    req.on("end", function () {
      var data = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(data);
      res.writeHead(200, { "content-type": "text/event-stream" });
      var output = [];
      if (command) {
        var call = { id: "fc_" + requests.length, call_id: "call_" + requests.length,
          type: "function_call", name: "exec_command",
          arguments: JSON.stringify({ cmd: command, login: false, max_output_tokens: 1000 }) };
        command = "";
        output.push(call);
        res.write(event("response.output_item.added", { output_index: 0, item: Object.assign({}, call, { arguments: "" }) }));
        res.write(event("response.output_item.done", { output_index: 0, item: call }));
      }
      res.end(event("response.completed", { response: { id: "fixture-" + requests.length,
        status: "completed", output: output, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }));
    });
  });
  await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
  var mcp = path.join(dir, "fixture-mcp.js");
  fs.writeFileSync(mcp, [
    'var rl = require("readline").createInterface({ input: process.stdin });',
    'rl.on("line", function (line) { var msg = JSON.parse(line); if (msg.id === undefined) return;',
    'var result = msg.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} },',
    'serverInfo: { name: "fixture", version: "1" } } : msg.method === "tools/list" ? { tools: [',
    '{ name: "fixture_mutation", description: "Fixture only", inputSchema: { type: "object", properties: {} } } ] } : {};',
    'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result }) + "\\n"); });',
  ].join("\n"));
  native = new nativeModule.CodexAppServer(binary, { cwd: dir,
    env: Object.assign({}, process.env, { CODEX_HOME: dir }),
    config: { model: "fixture-model", model_provider: "fixture",
      model_providers: { fixture: { name: "Local test fixture", wire_api: "responses",
        base_url: "http://127.0.0.1:" + server.address().port, requires_openai_auth: false } },
      features: { remote_models: false, plugins: false, apps: false, skip_host_skill_discovery: true },
      mcp_servers: { sentinel: { command: process.execPath, args: [mcp] } } } });
  t.after(function () { handles.forEach(function (h) { h.close(); }); native.stop(); server.close(); });
  await native.start();
  await native.send("initialize", { clientInfo: { name: "clay_readonly_test", version: "1" },
    capabilities: { experimentalApi: true } }, 10000);
  native.notify("initialized", {});
  native.subscribe(function () {});
  return { dir: dir, requests: requests, run: async function (readOnly, instruction, resume, sandbox) {
    command = instruction || "";
    var start = requests.length;
    var handle = createHandle(native, { cwd: dir, model: "fixture-model", readOnlyExecution: readOnly,
      sandboxMode: sandbox || "danger-full-access", approvalPolicy: "never", resumeSessionId: resume,
      abortController: new AbortController() });
    handles.push(handle);
    handle.pushMessage("Inspect the local fixture evidence.");
    var events = [];
    var timer = setTimeout(function () { handle.close(); }, 15000);
    try {
      for await (var item of handle) {
        events.push(item);
        if (item.yokeType === "result") break;
      }
    } finally { clearTimeout(timer); handle.close(); }
    return { requests: requests.slice(start), events: events,
      threadId: (events.find(function (e) { return e.yokeType === "session_id"; }) || {}).sessionId };
  } };
}

module.exports = { fixture: fixture };
