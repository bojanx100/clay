var updater = require("./updater");

var HOUR_MS = 60 * 60 * 1000;
var channels = Object.create(null);

function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
}

function applyVersion(entry, version, broadcast) {
  for (var subscriber of entry.subscribers) {
    if (version && entry.isNewer(version, subscriber.currentVersion)) {
      subscriber.latestVersion = version;
      if (broadcast) subscriber.sendToAdmins({ type: "update_available", version: version });
    }
  }
}

function runVersionCheck(entry, broadcast) {
  if (entry.inFlight) return entry.inFlight;
  entry.inFlight = Promise.resolve(entry.fetchVersion(entry.channel)).then(function (version) {
    entry.lastCheckedAt = Date.now();
    entry.latestVersion = version || null;
    applyVersion(entry, version, broadcast);
    return version;
  }).catch(function (e) {
    console.error("[project] Background version check failed:", e.message || e);
    return null;
  }).finally(function () {
    entry.inFlight = null;
  });
  return entry.inFlight;
}

function scheduleNextHourlyBroadcast(entry) {
  if (entry.timer || entry.subscribers.size === 0) return;
  var now = Date.now();
  var delay = HOUR_MS - (now % HOUR_MS);
  entry.timer = entry.setTimeout(function tick() {
    entry.timer = null;
    if (entry.subscribers.size === 0) return;
    runVersionCheck(entry, true);
    entry.timer = entry.setTimeout(tick, HOUR_MS);
    unrefTimer(entry.timer);
  }, delay);
  unrefTimer(entry.timer);
}

function sharedChannel(ctx) {
  var channel = ctx.updateChannel;
  var entry = channels[channel];
  if (entry) return entry;
  entry = {
    channel: channel,
    subscribers: new Set(),
    latestVersion: null,
    lastCheckedAt: 0,
    inFlight: null,
    timer: null,
    fetchVersion: ctx.fetchVersion || updater.fetchVersion,
    isNewer: ctx.isNewer || updater.isNewer,
    setTimeout: ctx.setTimeout || setTimeout,
    clearTimeout: ctx.clearTimeout || clearTimeout,
  };
  channels[channel] = entry;
  return entry;
}

function attachProjectUpdateChecker(ctx) {
  var entry = sharedChannel(ctx);
  var subscriber = {
    currentVersion: ctx.currentVersion,
    sendToAdmins: ctx.sendToAdmins,
    latestVersion: null,
  };
  entry.subscribers.add(subscriber);

  if (entry.lastCheckedAt && Date.now() - entry.lastCheckedAt < HOUR_MS) {
    applyVersion(entry, entry.latestVersion, false);
  } else {
    runVersionCheck(entry, false);
  }
  scheduleNextHourlyBroadcast(entry);

  function getLatestVersion() {
    return subscriber.latestVersion;
  }

  function setLatestVersion(version) {
    subscriber.latestVersion = version;
  }

  function stop() {
    if (!entry.subscribers.delete(subscriber)) return;
    if (entry.subscribers.size > 0) return;
    if (entry.timer) entry.clearTimeout(entry.timer);
    entry.timer = null;
    delete channels[entry.channel];
  }

  return {
    getLatestVersion: getLatestVersion,
    setLatestVersion: setLatestVersion,
    stop: stop,
  };
}

function resetForTests() {
  var names = Object.keys(channels);
  for (var i = 0; i < names.length; i++) {
    var entry = channels[names[i]];
    if (entry.timer) entry.clearTimeout(entry.timer);
    delete channels[names[i]];
  }
}

module.exports = {
  attachProjectUpdateChecker: attachProjectUpdateChecker,
  _resetForTests: resetForTests,
};
