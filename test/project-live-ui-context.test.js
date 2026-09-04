var test = require("node:test");
var assert = require("node:assert");
var sanitizeSelectionPacket =
  require("../lib/project-live-ui-context").sanitizeSelectionPacket;
var sanitizeDiagnosticsPacket =
  require("../lib/project-live-ui-context").sanitizeDiagnosticsPacket;

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
    component: {
      framework: "react",
      name: "PricingCard",
      chain: ["PricingCard", "PricingGrid", "App"],
      source: {
        file: "http://localhost:5173/src/components/PricingCard.tsx?t=secret",
        line: 42,
        column: 5,
      },
    },
  };
}

test("selection packets are bounded and scrub rendered PII", function () {
  var result = sanitizeSelectionPacket(validPacket());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.packet.tag, "section");
  assert.match(result.packet.text, /\[redacted-email\]/);
  assert.match(result.packet.text, /\[redacted-token\]/);
  assert.strictEqual(result.packet.fingerprint.length, 24);
  assert.strictEqual(result.packet.component.name, "PricingCard");
  assert.strictEqual(result.packet.component.source.file,
    "src/components/PricingCard.tsx");
  assert.strictEqual(result.packet.component.componentId.length, 20);
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

test("diagnostics are bounded, scrubbed, and remove URL queries", function () {
  var result = sanitizeDiagnosticsPacket({
    console: [{
      level: "error",
      text: "Request failed for jane@example.com with abcdefghijklmnopqrstuvwxyz123456",
    }],
    network: [{
      method: "POST",
      url: "https://api.example.com/bookings?authorization=secret",
      status: 500,
      duration: 42,
    }],
  });
  assert.strictEqual(result.ok, true);
  assert.match(result.packet.console[0].text, /\[redacted-email\]/);
  assert.match(result.packet.console[0].text, /\[redacted-token\]/);
  assert.strictEqual(result.packet.network[0].url,
    "https://api.example.com/bookings");
});
