#!/usr/bin/env node
// Read-only unless --restart is explicit. Always name the serving socket and
// expected checkout; never infer a runtime from the shell's working directory.
var path = require("path");
var activation = require("../lib/runtime-activation");
var sendIPC = require("../lib/ipc").sendIPCCommand;

async function run(options) {
  var expected = activation.sourceIdentity(options.checkout);
  if (options.revision && expected.revision !== options.revision) {
    return { ok: false, error: "Expected checkout is not at the requested revision." };
  }
  var before = await sendIPC(options.socket, { cmd: "runtime_identity" });
  if (!before || !before.ok || !before.runtime) {
    return { ok: false, error: "The selected runtime cannot report activation evidence. No restart was attempted.", response: before };
  }
  var verified = activation.verify(before.runtime, expected);
  if (verified.ok || !options.restart) return verified;
  var restart = await sendIPC(options.socket, { cmd: "restart", activation: expected });
  if (!restart || !restart.ok) return restart;
  var deadline = Date.now() + (options.timeoutMs || 30000);
  while (Date.now() < deadline) {
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
    var current = await sendIPC(options.socket, { cmd: "runtime_identity" }, 1500);
    verified = activation.verify(current && current.runtime, expected);
    if (verified.ok) return verified;
  }
  return { ok: false, code: "ACTIVATION_PENDING", error: "Restart was requested, but activation is not yet verified.", runtime: verified.runtime };
}

if (require.main === module) {
  var args = process.argv.slice(2);
  var options = {};
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--restart") options.restart = true;
    else if (["--socket", "--checkout", "--revision"].indexOf(args[i]) !== -1) options[args[i].slice(2)] = args[++i];
    else { console.error("Unknown argument: " + args[i]); process.exit(2); }
  }
  if (!options.socket || !options.checkout) {
    console.error("Usage: node scripts/verify-runtime-activation.js --socket PATH --checkout PATH [--revision SHA] [--restart]");
    process.exit(2);
  }
  options.checkout = path.resolve(options.checkout);
  run(options).then(function (result) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }).catch(function (error) { console.error(error.message); process.exitCode = 1; });
}

module.exports = { run: run };
