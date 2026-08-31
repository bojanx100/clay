var fs = require("fs");
var path = require("path");
var config = require("./config");

var DAY_MS = 24 * 60 * 60 * 1000;
var DEFAULT_CAP_MINUTES = 8 * 60;
var DEFAULT_THINKING_GRACE_MS = 5 * 60 * 1000;
var DEFAULT_SIGNAL_LEASE_MS = 25 * 1000;
var DEFAULT_SAVE_DELAY_MS = 30 * 1000;

function safeNumber(value) {
  return typeof value === "number" && isFinite(value) && value >= 0 ? value : 0;
}

function normalizeOffset(value) {
  var offset = Number(value);
  if (!isFinite(offset)) return 0;
  offset = Math.round(offset);
  if (offset < -840) return -840;
  if (offset > 840) return 840;
  return offset;
}

function normalizeProjectSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,160}$/.test(value)) return "unknown";
  return value;
}

function workdayKey(timestamp, timezoneOffsetMinutes, startHour) {
  var offset = normalizeOffset(timezoneOffsetMinutes);
  var hour = typeof startHour === "number" ? startHour : 5;
  var shifted = timestamp - (offset * 60 * 1000) - (hour * 60 * 60 * 1000);
  return new Date(shifted).toISOString().slice(0, 10);
}

function nextWorkdayBoundary(timestamp, timezoneOffsetMinutes, startHour) {
  var offset = normalizeOffset(timezoneOffsetMinutes);
  var hour = typeof startHour === "number" ? startHour : 5;
  var shift = (offset * 60 * 1000) + (hour * 60 * 60 * 1000);
  var shifted = timestamp - shift;
  return (Math.floor(shifted / DAY_MS) + 1) * DAY_MS + shift;
}

function normalizeProjectMap(value) {
  var result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    var slug = normalizeProjectSlug(keys[i]);
    var duration = safeNumber(value[keys[i]]);
    if (duration > 0) result[slug] = (result[slug] || 0) + duration;
  }
  return result;
}

function normalizeUser(value, createdAt, timezoneOffsetMinutes, startHour) {
  var source = value && typeof value === "object" ? value : {};
  var days = {};
  var dayKeys = source.days && typeof source.days === "object" ? Object.keys(source.days) : [];
  for (var i = 0; i < dayKeys.length; i++) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKeys[i])) continue;
    var day = source.days[dayKeys[i]] || {};
    days[dayKeys[i]] = {
      totalMs: safeNumber(day.totalMs),
      projects: normalizeProjectMap(day.projects),
    };
  }
  var cap = Number(source.capMinutes);
  if (!isFinite(cap) || cap < 30 || cap > 1440) cap = DEFAULT_CAP_MINUTES;
  var recordingStartedAt = safeNumber(source.recordingStartedAt);
  var recordingStartedWorkday = typeof source.recordingStartedWorkday === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(source.recordingStartedWorkday)
    ? source.recordingStartedWorkday : "";
  var recordingStartExact = source.recordingStartExact === true && recordingStartedAt > 0;
  if (!recordingStartedWorkday) {
    if (recordingStartedAt > 0) {
      recordingStartedWorkday = workdayKey(recordingStartedAt, timezoneOffsetMinutes, startHour);
    } else {
      var recordedDays = Object.keys(days).filter(function (key) { return days[key].totalMs > 0; }).sort();
      if (recordedDays.length) {
        recordingStartedWorkday = recordedDays[0];
      } else {
        recordingStartedAt = safeNumber(createdAt);
        recordingStartedWorkday = workdayKey(recordingStartedAt, timezoneOffsetMinutes, startHour);
        recordingStartExact = recordingStartedAt > 0;
      }
    }
  }
  return {
    capMinutes: Math.round(cap),
    totalMs: safeNumber(source.totalMs),
    projects: normalizeProjectMap(source.projects),
    days: days,
    recordingStartedAt: recordingStartedAt,
    recordingStartedWorkday: recordingStartedWorkday,
    recordingStartExact: recordingStartExact,
  };
}

function createHumanAttention(options) {
  var opts = options || {};
  var fsModule = opts.fsModule || fs;
  var pathModule = opts.pathModule || path;
  var nowFn = opts.now || Date.now;
  var setTimeoutFn = opts.setTimeout || setTimeout;
  var clearTimeoutFn = opts.clearTimeout || clearTimeout;
  var thinkingGraceMs = opts.thinkingGraceMs || DEFAULT_THINKING_GRACE_MS;
  var signalLeaseMs = opts.signalLeaseMs || DEFAULT_SIGNAL_LEASE_MS;
  var saveDelayMs = opts.saveDelayMs === undefined ? DEFAULT_SAVE_DELAY_MS : opts.saveDelayMs;
  var dayStartHour = opts.dayStartHour === undefined ? 5 : opts.dayStartHour;
  var defaultPath = pathModule.join(config.CONFIG_DIR,
    process.env.CLAY_DEV ? "human-attention-dev.json" : "human-attention.json");
  var filePath = opts.filePath === undefined ? defaultPath : opts.filePath;
  var clients = new Map();
  var users = {};
  var dirty = false;
  var saveTimer = null;
  var lastReconciledAt = nowFn();

  function load() {
    if (!filePath) return;
    try {
      var parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
      var sourceUsers = parsed && parsed.version === 1 && parsed.users || {};
      var ids = Object.keys(sourceUsers);
      for (var i = 0; i < ids.length; i++) {
        users[ids[i]] = normalizeUser(sourceUsers[ids[i]], lastReconciledAt, 0, dayStartHour);
      }
    } catch (e) {}
  }

  function ensureUser(userId, at, offset) {
    var id = typeof userId === "string" && userId ? userId : "_default";
    if (!users[id]) users[id] = normalizeUser(null,
      at === undefined ? nowFn() : at, offset, dayStartHour);
    return users[id];
  }

  function writeNow() {
    if (!filePath || !dirty) return;
    if (saveTimer) {
      clearTimeoutFn(saveTimer);
      saveTimer = null;
    }
    try {
      fsModule.mkdirSync(pathModule.dirname(filePath), { recursive: true });
      var tempPath = filePath + ".tmp-" + process.pid;
      fsModule.writeFileSync(tempPath, JSON.stringify({ version: 1, users: users }, null, 2) + "\n", "utf8");
      fsModule.renameSync(tempPath, filePath);
      dirty = false;
    } catch (e) {
      try { console.error("[human-attention] Failed to persist metrics:", e.message); } catch (e2) {}
    }
  }

  function scheduleSave() {
    dirty = true;
    if (!filePath || saveTimer) return;
    if (saveDelayMs <= 0) {
      writeNow();
      return;
    }
    saveTimer = setTimeoutFn(function () {
      saveTimer = null;
      writeNow();
    }, saveDelayMs);
    if (saveTimer && typeof saveTimer.unref === "function") saveTimer.unref();
  }

  function addDuration(userId, projectSlug, startAt, endAt, offset) {
    if (!(endAt > startAt)) return;
    var user = ensureUser(userId, startAt, offset);
    var slug = normalizeProjectSlug(projectSlug);
    var total = endAt - startAt;
    user.totalMs += total;
    user.projects[slug] = (user.projects[slug] || 0) + total;
    var cursor = startAt;
    while (cursor < endAt) {
      var key = workdayKey(cursor, offset, dayStartHour);
      var boundary = nextWorkdayBoundary(cursor, offset, dayStartHour);
      var partEnd = Math.min(endAt, boundary);
      var duration = partEnd - cursor;
      if (!user.days[key]) user.days[key] = { totalMs: 0, projects: {} };
      user.days[key].totalMs += duration;
      user.days[key].projects[slug] = (user.days[key].projects[slug] || 0) + duration;
      cursor = partEnd;
    }
    scheduleSave();
  }

  function leaseUntil(state) {
    if (!state || !state.activeSince || !state.explicitAt || !state.lastEvidenceAt) return 0;
    if (state.mobileForeground) return state.lastEvidenceAt + signalLeaseMs;
    return Math.min(state.lastEvidenceAt + signalLeaseMs, state.explicitAt + thinkingGraceMs);
  }

  function chooseSource(states, startAt, endAt) {
    var chosen = null;
    for (var i = 0; i < states.length; i++) {
      var state = states[i];
      if (!state.activeSince || state.activeSince > startAt || leaseUntil(state) < endAt) continue;
      if (!chosen || state.explicitAt > chosen.explicitAt ||
          (state.explicitAt === chosen.explicitAt && state.lastEvidenceAt > chosen.lastEvidenceAt) ||
          (state.explicitAt === chosen.explicitAt && state.lastEvidenceAt === chosen.lastEvidenceAt &&
            state.projectSlug < chosen.projectSlug)) chosen = state;
    }
    return chosen;
  }

  function reconcile(targetAt) {
    var now = Number(targetAt);
    if (!isFinite(now) || now <= lastReconciledAt) return;
    var byUser = {};
    clients.forEach(function (state) {
      if (!byUser[state.userId]) byUser[state.userId] = [];
      byUser[state.userId].push(state);
    });
    var userIds = Object.keys(byUser);
    for (var u = 0; u < userIds.length; u++) {
      var states = byUser[userIds[u]];
      var boundaries = [lastReconciledAt, now];
      for (var s = 0; s < states.length; s++) {
        var activeFrom = states[s].activeSince;
        var activeUntil = leaseUntil(states[s]);
        if (activeFrom > lastReconciledAt && activeFrom < now) boundaries.push(activeFrom);
        if (activeUntil > lastReconciledAt && activeUntil < now) boundaries.push(activeUntil);
      }
      boundaries.sort(function (left, right) { return left - right; });
      for (var b = 0; b < boundaries.length - 1; b++) {
        if (boundaries[b + 1] <= boundaries[b]) continue;
        var source = chooseSource(states, boundaries[b], boundaries[b + 1]);
        if (source) addDuration(userIds[u], source.projectSlug,
          boundaries[b], boundaries[b + 1], source.timezoneOffsetMinutes);
      }
    }
    lastReconciledAt = now;
  }

  function signal(clientKey, input) {
    var at = nowFn();
    reconcile(at);
    var value = input || {};
    var userId = typeof value.userId === "string" && value.userId ? value.userId : "_default";
    var previous = clients.get(clientKey);
    var state = previous && previous.userId === userId ? previous : {
      userId: userId,
      activeSince: 0,
      explicitAt: 0,
      lastEvidenceAt: 0,
      projectSlug: "unknown",
      sessionId: null,
      timezoneOffsetMinutes: 0,
      mobileForeground: false,
    };
    var mobileForeground = value.visible === true && value.mobileForeground === true;
    var active = value.visible === true && value.engaged === true &&
      (value.focused === true || mobileForeground);
    if (value.interaction === true && active) state.explicitAt = at;
    var previousLease = leaseUntil(state);
    state.userId = userId;
    state.projectSlug = normalizeProjectSlug(value.projectSlug);
    state.sessionId = value.sessionId === undefined || value.sessionId === null
      ? null : String(value.sessionId).slice(0, 160);
    state.timezoneOffsetMinutes = normalizeOffset(value.timezoneOffsetMinutes);
    state.mobileForeground = active && mobileForeground;
    if (active && state.explicitAt > 0 &&
        (state.mobileForeground || at < state.explicitAt + thinkingGraceMs)) {
      if (!state.activeSince || previousLease < at) state.activeSince = at;
      state.lastEvidenceAt = at;
    } else {
      state.activeSince = 0;
      state.lastEvidenceAt = 0;
    }
    clients.set(clientKey, state);
    ensureUser(userId, at, state.timezoneOffsetMinutes);
    return summary(userId, state.timezoneOffsetMinutes, state.projectSlug, at);
  }

  function disconnect(clientKey) {
    var at = nowFn();
    reconcile(at);
    clients.delete(clientKey);
  }

  function dateKeys(timestamp, offset, count) {
    var shifted = timestamp - (normalizeOffset(offset) * 60 * 1000) -
      (dayStartHour * 60 * 60 * 1000);
    var dayNumber = Math.floor(shifted / DAY_MS);
    var keys = [];
    for (var i = 0; i < count; i++) keys.push(new Date((dayNumber - i) * DAY_MS).toISOString().slice(0, 10));
    return keys;
  }

  function projectRows(projects) {
    return Object.keys(projects || {}).map(function (slug) {
      return { projectSlug: slug, durationMs: safeNumber(projects[slug]) };
    }).sort(function (left, right) {
      if (right.durationMs !== left.durationMs) return right.durationMs - left.durationMs;
      return left.projectSlug < right.projectSlug ? -1 : 1;
    });
  }

  function userIsTracking(userId, at) {
    var active = false;
    clients.forEach(function (state) {
      if (state.userId === userId && state.activeSince && leaseUntil(state) > at) active = true;
    });
    return active;
  }

  function summary(userId, offset, currentProjectSlug, targetAt) {
    var at = targetAt === undefined ? nowFn() : targetAt;
    reconcile(at);
    var id = typeof userId === "string" && userId ? userId : "_default";
    var user = ensureUser(id, at, offset);
    var keys = dateKeys(at, offset, 10);
    var days = [];
    for (var i = 0; i < keys.length; i++) {
      var day = user.days[keys[i]] || { totalMs: 0, projects: {} };
      days.push({ key: keys[i], totalMs: day.totalMs, projects: projectRows(day.projects) });
    }
    var today = days[0];
    var capMs = user.capMinutes * 60 * 1000;
    var slug = normalizeProjectSlug(currentProjectSlug);
    var projectTodayMs = 0;
    for (var p = 0; p < today.projects.length; p++) {
      if (today.projects[p].projectSlug === slug) projectTodayMs = today.projects[p].durationMs;
    }
    return {
      type: "human_attention_state",
      measuredAt: at,
      dayStartHour: dayStartHour,
      capMinutes: user.capMinutes,
      capReached: today.totalMs >= capMs,
      remainingMs: Math.max(0, capMs - today.totalMs),
      tracking: userIsTracking(id, at),
      recordingStartedAt: user.recordingStartExact ? user.recordingStartedAt : null,
      recordingStartedWorkday: user.recordingStartedWorkday,
      recordingStartExact: user.recordingStartExact,
      partialToday: user.recordingStartedWorkday === keys[0],
      todayMs: today.totalMs,
      projectTodayMs: projectTodayMs,
      totalMs: user.totalMs,
      projects: projectRows(user.projects),
      days: days,
    };
  }

  function setCapMinutes(userId, capMinutes) {
    var cap = Number(capMinutes);
    if (!isFinite(cap) || cap < 30 || cap > 1440) return { ok: false, error: "Daily cap must be between 0.5 and 24 hours" };
    var user = ensureUser(userId);
    user.capMinutes = Math.round(cap);
    scheduleSave();
    writeNow();
    return { ok: true, capMinutes: user.capMinutes };
  }

  function destroy() {
    reconcile(nowFn());
    clients.clear();
    writeNow();
  }

  load();

  return {
    signal: signal,
    disconnect: disconnect,
    summary: summary,
    setCapMinutes: setCapMinutes,
    flush: writeNow,
    destroy: destroy,
  };
}

module.exports = {
  createHumanAttention: createHumanAttention,
  workdayKey: workdayKey,
  nextWorkdayBoundary: nextWorkdayBoundary,
  DEFAULT_CAP_MINUTES: DEFAULT_CAP_MINUTES,
};
