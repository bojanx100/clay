var test = require("node:test");
var assert = require("node:assert/strict");
var zlib = require("node:zlib");

var claudeAdapter = require("../lib/yoke/adapters/claude");
var claudeImageInput = require("../lib/yoke/adapters/claude-image-input");

function crc32(buffer) {
  var value = 0xffffffff;
  for (var i = 0; i < buffer.length; i++) {
    value ^= buffer[i];
    for (var bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  var name = Buffer.from(type, "ascii");
  var chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function png(width, height) {
  var signature = Buffer.from("89504e470d0a1a0a", "hex");
  var header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  var rowBytes = (width * 4) + 1;
  var pixels = Buffer.alloc(rowBytes * height);
  for (var row = 0; row < height; row++) pixels[row * rowBytes] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function emptyAsyncQuery() {
  return {
    [Symbol.asyncIterator]: function() {
      return { next: function() { return Promise.resolve({ done: true }); } };
    },
    close: function() {},
  };
}

function gif(width, height) {
  var bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function jpeg(width, height) {
  var bytes = Buffer.alloc(23);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes.writeUInt16BE(17, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function webp(width, height) {
  var bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

test("Claude verifies dimensions for every supported image format", function () {
  assert.deepEqual(claudeImageInput.imageDimensions("image/png", Buffer.from(png(640, 480), "base64")),
    { width: 640, height: 480 });
  assert.deepEqual(claudeImageInput.imageDimensions("image/gif", gif(641, 481)),
    { width: 641, height: 481 });
  assert.deepEqual(claudeImageInput.imageDimensions("image/jpeg", jpeg(642, 482)),
    { width: 642, height: 482 });
  assert.deepEqual(claudeImageInput.imageDimensions("image/webp", webp(643, 483)),
    { width: 643, height: 483 });
});

test("Claude embeds only images inside the many-image-safe dimension envelope", function () {
  var safe = { mediaType: "image/png", data: png(2000, 1), savedPath: "/tmp/safe.png" };
  var unsafe = { mediaType: "image/png", data: png(2001, 1), savedPath: "/tmp/wide.png" };
  var content = claudeImageInput.buildContent("Inspect both", [safe, unsafe]);

  assert.equal(content.filter(function(block) { return block.type === "image"; }).length, 1);
  assert.equal(content[0].source.data, safe.data);
  assert.match(content[1].text, /2001x1 exceeds Claude's 2000-pixel many-image limit/);
  assert.match(content[1].text, /\/tmp\/wide\.png/);
});

test("Claude embeds the normalized copy while the original attachment remains preserved", function () {
  var original = png(2557, 961);
  var normalized = png(1920, 722);
  var content = claudeImageInput.buildContent("Inspect", [{
    mediaType: "image/png",
    data: original,
    providerMediaType: "image/png",
    providerData: normalized,
    savedPath: "/tmp/original.png",
  }]);

  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.data, normalized);
  assert.notEqual(content[0].source.data, original);
  assert.deepEqual(claudeImageInput.providerImage({
    mediaType: "image/png", data: original, providerData: normalized,
    savedPath: "/tmp/original.png",
  }).savedPath, "/tmp/original.png");
});

test("Claude adapter applies the guard to the real message queue", async function () {
  var queue = claudeAdapter.contractTestKit.createMessageQueue();
  var handle = claudeAdapter.contractTestKit.createQueryHandle(
    emptyAsyncQuery(), queue, new AbortController());
  var next = queue[Symbol.asyncIterator]().next();
  handle.pushMessage("Inspect", [{
    mediaType: "image/png",
    data: png(2557, 961),
    savedPath: "/tmp/original.png",
  }]);
  var queued = (await next).value;
  handle.close();

  assert.equal(queued.message.content.length, 1);
  assert.equal(queued.message.content[0].type, "text");
  assert.match(queued.message.content[0].text, /did not embed image attachment 1/);
  assert.match(queued.message.content[0].text, /View the preserved original/);
});

test("more than twenty accumulated direct images remain within Anthropic's stricter limit", function () {
  var images = [];
  for (var i = 0; i < 25; i++) {
    images.push({ mediaType: "image/png", data: png(2000, 1), savedPath: "/tmp/safe-" + i + ".png" });
  }
  images.push({ mediaType: "image/png", data: png(2309, 1), savedPath: "/tmp/unsafe.png" });
  var content = claudeImageInput.buildContent("Continue", images);
  var direct = content.filter(function(block) { return block.type === "image"; });

  assert.equal(direct.length, 25);
  for (var j = 0; j < direct.length; j++) {
    var dimensions = claudeImageInput.imageDimensions("image/png",
      Buffer.from(direct[j].source.data, "base64"));
    assert.ok(dimensions.width <= 2000 && dimensions.height <= 2000);
  }
  assert.match(content.at(-1).text, /2309x1 exceeds Claude's 2000-pixel many-image limit/);
});
