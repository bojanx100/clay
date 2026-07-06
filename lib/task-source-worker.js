// Child process that runs the GitHub task-source scan off the daemon's event
// loop. The scan makes many synchronous `gh` CLI calls (for a dozen PRs it does
// ~3 calls each and blocks ~25s); running it in the daemon froze the whole event
// loop, so every connected client's heartbeat failed and the app appeared to
// "crash"/reconnect every 5 minutes when the auto-launch loop fired.
//
// The parsing logic is reused UNCHANGED from project-task-sources.js — this only
// moves the blocking work into a dedicated process whose loop has nothing else to
// serve. The parent forks this, sends {cwd, recipe, args} over IPC, and awaits
// the {ok, items} reply, so the daemon loop stays responsive throughout.
var taskSources = require("./project-task-sources");

process.on("message", function (input) {
  var result;
  try {
    var items = taskSources.fetchItems(input.cwd, input.recipe, input.args || {});
    result = { ok: true, items: items || [] };
  } catch (e) {
    result = { ok: false, error: (e && e.message) || String(e) };
  }
  // Exit only AFTER the IPC message has been flushed to the parent. process.send
  // is asynchronous; calling process.exit(0) synchronously right after it races
  // the flush, and on newer Node versions the parent sees 'exit' before 'message'
  // and treats the scan as failed ("worker exited early"). The send callback
  // fires once the message is handed off, so exiting there is safe. If the IPC
  // channel is already gone, exit immediately.
  function done() { process.exit(0); }
  try {
    var sent = process.send(result, done);
    if (sent === false) done();
  } catch (sendErr) {
    done();
  }
});

// Safety: if the parent never sends work (shouldn't happen), don't linger.
setTimeout(function () { process.exit(0); }, 130000).unref();
