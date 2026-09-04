var test = require("node:test");
var assert = require("node:assert");

async function loadCronBuilders() {
  return await import("../lib/public/modules/scheduler-cron-builders.js");
}

test("scheduler cron builder offsets interval-only schedules from selected time", async function () {
  var cronBuilders = await loadCronBuilders();
  var cron = cronBuilders.buildCreateCronFromOptions({
    selectedDate: new Date(2026, 6, 4),
    hour: 9,
    minute: 7,
    recurrence: "none",
    interval: "15",
  });

  assert.strictEqual(cron, "7,22,37,52 * * * *");
});

test("scheduler cron builder combines weekly recurrence with hourly intervals", async function () {
  var cronBuilders = await loadCronBuilders();
  var cron = cronBuilders.buildCreateCronFromOptions({
    selectedDate: new Date(2026, 6, 6),
    hour: 8,
    minute: 30,
    recurrence: "weekly",
    interval: "custom",
    intervalCustom: { unit: "hour", value: 4 },
  });

  assert.strictEqual(cron, "30 0,4,8,12,16,20 * * 1");
});

test("scheduler custom weekly cron falls back to selected day when no days are chosen", async function () {
  var cronBuilders = await loadCronBuilders();
  var cron = cronBuilders.buildCreateCronFromOptions({
    selectedDate: new Date(2026, 6, 7),
    hour: 10,
    minute: 5,
    recurrence: "custom",
    customConfirmed: true,
    customInterval: 1,
    customUnit: "week",
    customDays: [],
  });

  assert.strictEqual(cron, "5 10 * * 2");
});
