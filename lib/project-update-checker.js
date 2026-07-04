var { fetchVersion, isNewer } = require("./updater");

function attachProjectUpdateChecker(ctx) {
  var currentVersion = ctx.currentVersion;
  var updateChannel = ctx.updateChannel;
  var sendToAdmins = ctx.sendToAdmins;
  var latestVersion = null;

  function runVersionCheck(broadcast) {
    fetchVersion(updateChannel).then(function (v) {
      if (v && isNewer(v, currentVersion)) {
        latestVersion = v;
        if (broadcast) sendToAdmins({ type: "update_available", version: v });
      }
    }).catch(function (e) {
      console.error("[project] Background version check failed:", e.message || e);
    });
  }

  function scheduleNextHourlyBroadcast() {
    var now = Date.now();
    var msUntilNextHour = 60 * 60 * 1000 - (now % (60 * 60 * 1000));
    setTimeout(function tick() {
      runVersionCheck(true);
      setTimeout(tick, 60 * 60 * 1000);
    }, msUntilNextHour);
  }

  function start() {
    runVersionCheck(false);
    scheduleNextHourlyBroadcast();
  }

  function getLatestVersion() {
    return latestVersion;
  }

  function setLatestVersion(v) {
    latestVersion = v;
  }

  start();

  return {
    getLatestVersion: getLatestVersion,
    setLatestVersion: setLatestVersion,
  };
}

module.exports = {
  attachProjectUpdateChecker: attachProjectUpdateChecker,
};
