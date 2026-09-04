var test = require("node:test");
var assert = require("node:assert");
var attachments = require("../lib/project-live-ui-attachments");

var PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("Live UI accepts bounded pasted images and text", function () {
  var result = attachments.sanitizeAttachments({
    images: [{
      mediaType: "image/png",
      data: PNG,
      name: "../../account screenshot.png",
    }],
    pastes: ["render log\ncomponent failed"],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.packet.images[0].name, "account screenshot.png");
  assert.deepStrictEqual(result.packet.pastes, ["render log\ncomponent failed"]);
});

test("Live UI rejects spoofed and oversized pasted context", function () {
  var spoofed = attachments.sanitizeAttachments({
    images: [{ mediaType: "image/png", data: "aGVsbG8=", name: "fake.png" }],
  });
  assert.strictEqual(spoofed.ok, false);
  assert.match(spoofed.error, /failed validation/);

  var oversized = attachments.sanitizeAttachments({
    pastes: ["x".repeat((64 * 1024) + 1)],
  });
  assert.strictEqual(oversized.ok, false);
  assert.match(oversized.error, /under 64 KB/);
});

test("Live UI stores pasted images and describes every attachment", function () {
  var sanitized = attachments.sanitizeAttachments({
    images: [{ mediaType: "image/png", data: PNG, name: "clock.png" }],
    pastes: ["Expected 12:30, received 12:03"],
  }).packet;
  var saved = [];
  var refs = attachments.storeImages(sanitized, {
    getLinuxUserForSession: function () { return "tester"; },
    saveImageFile: function (mediaType, data, owner) {
      saved.push({ mediaType: mediaType, data: data, owner: owner });
      return "pasted-clock.png";
    },
  }, {});
  assert.deepStrictEqual(refs, [{ mediaType: "image/png", file: "pasted-clock.png" }]);
  assert.strictEqual(saved[0].owner, "tester");
  var context = attachments.attachmentContext(sanitized);
  assert.match(context, /clock\.png/);
  assert.match(context, /Expected 12:30/);
});
