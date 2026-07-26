var test = require("node:test");
var assert = require("node:assert");
var sanitizeSelectionPacket =
  require("../lib/project-live-ui-context").sanitizeSelectionPacket;

function validPacket() {
  return {
    tag: "SECTION",
    role: "region",
    text: "Contact jane@example.com about abcdefghijklmnopqrstuvwxyz123456",
    accessibleName: "Professional plan",
    route: "/pricing",
    documentGeneration: "document-7",
    rect: { x: 12.25, y: 40, width: 320, height: 180 },
    selectors: ["#pricing-card", "section:nth-of-type(2)"],
  };
}

test("selection packets are bounded and scrub rendered PII", function () {
  var result = sanitizeSelectionPacket(validPacket());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.packet.tag, "section");
  assert.match(result.packet.text, /\[redacted-email\]/);
  assert.match(result.packet.text, /\[redacted-token\]/);
  assert.strictEqual(result.packet.fingerprint.length, 24);
  assert.deepStrictEqual(result.packet.rect, {
    x: 12.25,
    y: 40,
    width: 320,
    height: 180,
  });
});

test("selection packets reject sensitive value-bearing fields recursively", function () {
  var packet = validPacket();
  packet.element = { inputValue: "secret" };
  var result = sanitizeSelectionPacket(packet);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /forbidden sensitive field/);
});

test("selection packets reject oversized and incomplete payloads", function () {
  var oversized = validPacket();
  oversized.extra = "x".repeat(33 * 1024);
  assert.match(sanitizeSelectionPacket(oversized).error, /exceeds 32 KB/);

  var incomplete = validPacket();
  delete incomplete.documentGeneration;
  assert.match(sanitizeSelectionPacket(incomplete).error, /missing required/);
});
