// Process-local owner of the optional Slice 2 controller. Activation requires
// both ControlStore flags; flag-off callers receive a no-op controller.

var executions = require("./coop-control-executions");

var singleton = null;

function getExecutionControl(options) {
  var opts = options || {};
  if (opts.control) return opts.control;
  if (!singleton) {
    singleton = executions.createExecutionControl(opts);
    if (singleton.enabled) singleton.recoverIncomplete();
  }
  return singleton;
}

function closeExecutionControl() {
  if (singleton) singleton.close();
  singleton = null;
}

module.exports = {
  closeExecutionControl: closeExecutionControl,
  getExecutionControl: getExecutionControl,
};
