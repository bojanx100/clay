var workerTaskStatusFromResult = require("./orchestration-task-state").workerTaskStatusFromResult;

function terminalStatusForTurn(session, event, result) {
  if (session && session.streamEndedAutoRetryQueued) return "";
  var status = workerTaskStatusFromResult(result);
  var adapterShutdown = event && Number(event.code) !== 0 &&
    !/(?:^|\n)WORKER_STATUS:/i.test(String(result || ""));
  return adapterShutdown && status === "needs_input" ? "failed" : status;
}

module.exports = { terminalStatusForTurn: terminalStatusForTurn };
