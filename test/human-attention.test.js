var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var humanAttention = require("../lib/human-attention");

function createClock(value) {
  var current = value;
  return {
    now: function () { return current; },
    set: function (next) { current = next; },
    advance: function (duration) { current += duration; },
  };
}

function activeInput(projectSlug, interaction, offset) {
  return {
    userId: "owner",
    projectSlug: projectSlug,
    sessionId: "session-1",
    visible: true,
    focused: true,
    engaged: true,
    interaction: interaction,
    timezoneOffsetMinutes: offset === undefined ? -120 : offset,
  };
}

function mobileForegroundInput(projectSlug, interaction, visible) {
  var isVisible = visible !== false;
  return {
    userId: "owner",
    projectSlug: projectSlug,
    sessionId: "phone-session",
    visible: isVisible,
    focused: false,
    engaged: isVisible,
    interaction: interaction,
    mobileForeground: isVisible,
    timezoneOffsetMinutes: -120,
  };
}

test("phone and laptop leases are unioned once and attributed to the latest active project", function () {
  var base = Date.UTC(2026, 7, 31, 8, 0, 0);
  var clock = createClock(base);
  var service = humanAttention.createHumanAttention({ filePath: null, now: clock.now });
  var laptop = {};
  var phone = {};

  service.signal(laptop, activeInput("alpha", true));
  clock.advance(10000);
  service.signal(phone, activeInput("beta", true));
  clock.advance(10000);
  service.signal(laptop, activeInput("alpha", false));
  clock.advance(10000);
  service.signal(phone, activeInput("beta", false));

  var result = service.summary("owner", -120, "beta");
  assert.equal(result.todayMs, 30000, "overlapping devices must never double the elapsed wall time");
  assert.deepEqual(result.days[0].projects, [
    { projectSlug: "beta", durationMs: 20000 },
    { projectSlug: "alpha", durationMs: 10000 },
  ]);
  assert.equal(result.projectTodayMs, 20000);
});

test("hidden clients stop immediately and autonomous runtime never creates human time", function () {
  var base = Date.UTC(2026, 7, 31, 8, 0, 0);
  var clock = createClock(base);
  var service = humanAttention.createHumanAttention({ filePath: null, now: clock.now });
  var client = {};

  assert.equal(service.summary("owner", -120, "alpha").todayMs, 0,
    "server or agent activity without a client signal is not human work");
  service.signal(client, activeInput("alpha", true));
  clock.advance(10000);
  service.signal(client, {
    userId: "owner",
    projectSlug: "alpha",
    visible: false,
    focused: false,
    engaged: false,
    interaction: false,
    timezoneOffsetMinutes: -120,
  });
  clock.advance(120000);
  assert.equal(service.summary("owner", -120, "alpha").todayMs, 10000);
});

test("reading and thinking time ends at the bounded five-minute grace", function () {
  var base = Date.UTC(2026, 7, 31, 8, 0, 0);
  var clock = createClock(base);
  var service = humanAttention.createHumanAttention({ filePath: null, now: clock.now });
  var client = {};

  service.signal(client, activeInput("alpha", true));
  for (var elapsed = 20000; elapsed <= 280000; elapsed += 20000) {
    clock.set(base + elapsed);
    service.signal(client, activeInput("alpha", false));
  }
  clock.set(base + 360000);
  assert.equal(service.summary("owner", -120, "alpha").todayMs, 300000);
  assert.equal(service.summary("owner", -120, "alpha").tracking, false);
});

test("foreground phone evidence keeps a bounded five-minute background grace", function () {
  var base = Date.UTC(2026, 7, 31, 8, 0, 0);
  var clock = createClock(base);
  var service = humanAttention.createHumanAttention({ filePath: null, now: clock.now });
  var phone = {};

  service.signal(phone, mobileForegroundInput("alpha", true));
  for (var elapsed = 20000; elapsed <= 20 * 60000; elapsed += 20000) {
    clock.set(base + elapsed);
    service.signal(phone, mobileForegroundInput("alpha", false));
  }
  var foreground = service.summary("owner", -120, "alpha");
  assert.equal(foreground.todayMs, 20 * 60000);
  assert.equal(foreground.tracking, true);

  clock.advance(10000);
  service.signal(phone, mobileForegroundInput("alpha", false, false));
  clock.advance(120000);
  var backgrounded = service.summary("owner", -120, "alpha");
  assert.equal(backgrounded.todayMs, 22 * 60000 + 10000,
    "a short phone background interruption should remain human work");
  assert.equal(backgrounded.tracking, true);

  clock.advance(181000);
  var expired = service.summary("owner", -120, "alpha");
  assert.equal(expired.todayMs, 25 * 60000 + 10000,
    "unattended phone time must stop after the five-minute grace");
  assert.equal(expired.tracking, false);
});

test("a foreground phone disconnect keeps only the five-minute continuity grace", function () {
  var base = Date.UTC(2026, 7, 31, 8, 0, 0);
  var clock = createClock(base);
  var service = humanAttention.createHumanAttention({ filePath: null, now: clock.now });
  var phone = {};

  service.signal(phone, mobileForegroundInput("alpha", true));
  for (var elapsed = 20000; elapsed <= 60000; elapsed += 20000) {
    clock.set(base + elapsed);
    service.signal(phone, mobileForegroundInput("alpha", false));
  }
  service.disconnect(phone);
  clock.advance(10 * 60000);

  var result = service.summary("owner", -120, "alpha");
  assert.equal(result.todayMs, 6 * 60000,
    "a disconnected phone must not create more than five minutes of human time");
  assert.equal(result.tracking, false);
});

test("a workday reports partial coverage until the first complete 5am boundary", function () {
  var base = Date.UTC(2026, 7, 31, 16, 1, 0);
  var clock = createClock(base);
  var service = humanAttention.createHumanAttention({ filePath: null, now: clock.now });

  var first = service.summary("owner", -120, "alpha");
  assert.equal(first.recordingStartedAt, base);
  assert.equal(first.recordingStartExact, true);
  assert.equal(first.recordingStartedWorkday, "2026-08-31");
  assert.equal(first.partialToday, true,
    "a tracker started after 5am must not present its first day as complete");

  clock.set(Date.UTC(2026, 8, 1, 3, 0, 0));
  var nextDay = service.summary("owner", -120, "alpha");
  assert.equal(nextDay.days[0].key, "2026-09-01");
  assert.equal(nextDay.partialToday, false);
});

test("a Zagreb interval crossing 5am is split between the correct workdays", function () {
  var base = Date.UTC(2026, 7, 31, 2, 59, 0);
  var clock = createClock(base);
  var service = humanAttention.createHumanAttention({
    filePath: null,
    now: clock.now,
    signalLeaseMs: 5 * 60 * 1000,
    thinkingGraceMs: 5 * 60 * 1000,
  });
  var client = {};

  service.signal(client, activeInput("alpha", true, -120));
  clock.advance(2 * 60 * 1000);
  var result = service.signal(client, activeInput("alpha", false, -120));

  assert.equal(humanAttention.workdayKey(base, -120, 5), "2026-08-30");
  assert.equal(humanAttention.workdayKey(base + 2 * 60 * 1000, -120, 5), "2026-08-31");
  assert.equal(result.days[0].key, "2026-08-31");
  assert.equal(result.days[0].totalMs, 60000);
  assert.equal(result.days[1].key, "2026-08-30");
  assert.equal(result.days[1].totalMs, 60000);
});

test("daily cap and measured totals survive a ledger reload", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-human-attention-"));
  var filePath = path.join(dir, "attention.json");
  var base = Date.UTC(2026, 7, 31, 8, 0, 0);
  var clock = createClock(base);
  try {
    var service = humanAttention.createHumanAttention({ filePath: filePath, now: clock.now, saveDelayMs: 0 });
    var client = {};
    service.signal(client, activeInput("alpha", true));
    clock.advance(60000);
    service.signal(client, {
      userId: "owner", projectSlug: "alpha", visible: false, focused: false,
      engaged: false, interaction: false, timezoneOffsetMinutes: -120,
    });
    assert.deepEqual(service.setCapMinutes("owner", 360), { ok: true, capMinutes: 360 });
    service.destroy();

    var restored = humanAttention.createHumanAttention({ filePath: filePath, now: clock.now, saveDelayMs: 0 });
    var result = restored.summary("owner", -120, "alpha");
    assert.equal(result.todayMs, 25000, "the signal lease excludes an unproven gap longer than 25 seconds");
    assert.equal(result.capMinutes, 360);
    assert.equal(result.remainingMs, 360 * 60000 - 25000);
    assert.equal(result.recordingStartedAt, base);
    assert.equal(result.recordingStartExact, true);
    assert.equal(result.partialToday, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy aggregate is marked partial without inventing an exact start time", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-human-attention-legacy-"));
  var filePath = path.join(dir, "attention.json");
  var at = Date.UTC(2026, 7, 31, 18, 30, 0);
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      users: {
        owner: {
          capMinutes: 480,
          totalMs: 480000,
          projects: { clay: 480000 },
          days: { "2026-08-31": { totalMs: 480000, projects: { clay: 480000 } } },
        },
      },
    }), "utf8");
    var service = humanAttention.createHumanAttention({ filePath: filePath, now: function () { return at; } });
    var result = service.summary("owner", -120, "clay");
    assert.equal(result.todayMs, 480000);
    assert.equal(result.recordingStartedAt, null);
    assert.equal(result.recordingStartExact, false);
    assert.equal(result.recordingStartedWorkday, "2026-08-31");
    assert.equal(result.partialToday, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
