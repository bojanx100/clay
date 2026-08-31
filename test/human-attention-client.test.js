var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function loadClientModule() {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules",
    "human-attention.js"), "utf8");
  source = source.replace(/^import .*;\n/gm, "");
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64") +
    "#" + Math.random());
}

test("client attention policy requires a visible focused page and recent interaction", async function () {
  var client = await loadClientModule();
  var now = 1000000;
  assert.deepEqual(client.buildAttentionSignalPayload(now, true, true, now - 1000, true, -120), {
    type: "human_attention_signal",
    visible: true,
    focused: true,
    engaged: true,
    interaction: true,
    timezoneOffsetMinutes: -120,
  });
  assert.equal(client.buildAttentionSignalPayload(now, false, true, now - 1000, true, -120).engaged, false);
  assert.equal(client.buildAttentionSignalPayload(now, true, false, now - 1000, true, -120).engaged, false);
  assert.equal(client.buildAttentionSignalPayload(now, true, true, now - 299000, false, -120).engaged, true);
  assert.equal(client.buildAttentionSignalPayload(now, true, true, now - 301000, false, -120).engaged, false);
});

test("client duration labels stay compact for the title-bar budget chip", async function () {
  var client = await loadClientModule();
  assert.equal(client.formatDuration(59000), "0m");
  assert.equal(client.formatDuration(60 * 60000), "1h");
  assert.equal(client.formatDuration(95 * 60000), "1h 35m");
});

test("coverage label does not present a partial first day as a full 5am workday", async function () {
  var client = await loadClientModule();
  assert.equal(client.trackingCoverageLabel({
    partialToday: true,
    recordingStartExact: true,
    recordingStartedAt: 1788192092231,
  }, function () { return "18:01"; }),
  "Partial day · tracking since 18:01 · all Clay devices");
  assert.equal(client.trackingCoverageLabel({
    partialToday: true,
    recordingStartExact: false,
  }), "Partial day · earlier time unavailable · all Clay devices");
  assert.equal(client.trackingCoverageLabel({ partialToday: false }),
    "5am–5am · all Clay devices");
});

test("attention popover dismisses immediately for touch and remains keyboard accessible", async function () {
  var client = await loadClientModule();
  var prevented = 0;
  var stopped = 0;
  var dismissed = 0;
  var pointerEvent = {
    type: "pointerdown",
    preventDefault: function () { prevented++; },
    stopPropagation: function () { stopped++; },
  };

  assert.equal(client.handleAttentionDismissEvent(pointerEvent, function () { dismissed++; }), true);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
  assert.equal(dismissed, 1);

  assert.equal(client.handleAttentionDismissEvent({
    type: "keydown",
    key: "Escape",
    stopPropagation: function () { stopped++; },
  }, function () { dismissed++; }), true);
  assert.equal(stopped, 2);
  assert.equal(dismissed, 2);

  assert.equal(client.handleAttentionDismissEvent({ type: "keydown", key: "Enter" }, function () {
    dismissed++;
  }), false);
  assert.equal(dismissed, 2);
});
