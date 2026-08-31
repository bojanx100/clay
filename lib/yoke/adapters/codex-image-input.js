var fs = require("fs");
var zlib = require("zlib");

var PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
var PNG_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
var SUPPORTED_MEDIA_TYPES = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};

function crc32(buffer, start, end) {
  var value = 0xffffffff;
  for (var i = start; i < end; i++) {
    value ^= buffer[i];
    for (var bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function hasPrefix(buffer, prefix) {
  if (buffer.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) {
    if (buffer[i] !== prefix[i]) return false;
  }
  return true;
}

function validPng(buffer) {
  if (!hasPrefix(buffer, PNG_SIGNATURE)) return false;
  var offset = PNG_SIGNATURE.length;
  var sawHeader = false;
  var sawData = false;
  var sawEnd = false;
  var compressed = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) return false;
    var length = buffer.readUInt32BE(offset);
    var typeStart = offset + 4;
    var dataStart = offset + 8;
    var dataEnd = dataStart + length;
    var crcEnd = dataEnd + 4;
    if (dataEnd < dataStart || crcEnd > buffer.length) return false;
    var type = buffer.toString("ascii", typeStart, dataStart);
    if (buffer.readUInt32BE(dataEnd) !== crc32(buffer, typeStart, dataEnd)) return false;
    if (type === "IHDR") {
      if (sawHeader || offset !== PNG_SIGNATURE.length || length !== 13 ||
          buffer.readUInt32BE(dataStart) === 0 || buffer.readUInt32BE(dataStart + 4) === 0) return false;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd) return false;
      sawData = true;
      compressed.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (!sawHeader || !sawData || length !== 0 || crcEnd !== buffer.length) return false;
      sawEnd = true;
    }
    offset = crcEnd;
  }
  if (!sawHeader || !sawData || !sawEnd) return false;
  try {
    zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: PNG_MAX_DECOMPRESSED_BYTES });
    return true;
  } catch (e) {
    return false;
  }
}

function isJpegStartOfFrame(marker) {
  return marker >= 0xc0 && marker <= 0xcf &&
    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function nextJpegScanMarker(buffer, offset) {
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    var markerStart = offset;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) return -1;
    var marker = buffer[offset];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset++;
      continue;
    }
    return markerStart;
  }
  return -1;
}

function validJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  var offset = 2;
  var sawFrame = false;
  var sawScan = false;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return false;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) return false;
    var marker = buffer[offset++];
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (marker === 0xd9) return sawFrame && sawScan;
    if (marker === 0x01) continue;
    if (offset + 2 > buffer.length) return false;
    var length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return false;
    if (isJpegStartOfFrame(marker)) {
      if (length < 11) return false;
      var components = buffer[offset + 7];
      if (!components || length !== 8 + (components * 3) ||
          buffer.readUInt16BE(offset + 3) === 0 || buffer.readUInt16BE(offset + 5) === 0) return false;
      sawFrame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!sawFrame) return false;
      sawScan = true;
      offset = nextJpegScanMarker(buffer, offset);
      if (offset < 0) return false;
    }
  }
  return false;
}

function detectedMediaType(buffer) {
  if (hasPrefix(buffer, PNG_SIGNATURE)) return validPng(buffer) ? "image/png" : "invalid-png";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return validJpeg(buffer) ? "image/jpeg" : "invalid-jpeg";
  }
  if (buffer.length >= 7 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a") &&
      buffer[buffer.length - 1] === 0x3b) return "image/gif";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function inspectImage(image) {
  var candidate = image || {};
  var imagePath = typeof candidate.savedPath === "string" ? candidate.savedPath : "";
  if (!imagePath) return { ok: false, reason: "a persisted local image path is unavailable", path: null };
  var bytes;
  try {
    var stats = fs.statSync(imagePath);
    if (!stats.isFile()) return { ok: false, reason: "the persisted image path is not a regular file", path: imagePath };
    bytes = fs.readFileSync(imagePath);
  } catch (e) {
    return { ok: false, reason: "the persisted image file is unavailable", path: imagePath };
  }
  var actual = detectedMediaType(bytes);
  if (actual === "invalid-png") return { ok: false, reason: "invalid PNG data", path: imagePath };
  if (actual === "invalid-jpeg") return { ok: false, reason: "invalid JPEG data", path: imagePath };
  if (!actual || !SUPPORTED_MEDIA_TYPES[actual]) return { ok: false, reason: "unsupported or corrupt image data", path: imagePath };
  if (candidate.mediaType && candidate.mediaType !== actual) {
    return { ok: false, reason: "declared " + candidate.mediaType + " but the file is " + actual, path: imagePath };
  }
  return { ok: true, path: imagePath };
}

function warningForImage(index, inspection) {
  var retained = inspection.path ? " The original file remains at " + inspection.path + "." : " No file was removed.";
  return "[Clay preserved image attachment " + (index + 1) + " but did not send it to Codex: " + inspection.reason + "." + retained + "]";
}

function buildInput(text, images) {
  var input = [];
  var warnings = [];
  var attachments = Array.isArray(images) ? images : [];
  for (var i = 0; i < attachments.length; i++) {
    var inspection = inspectImage(attachments[i]);
    if (inspection.ok) {
      input.push({ type: "localImage", path: inspection.path });
    } else {
      warnings.push(warningForImage(i, inspection));
    }
  }
  var message = text || "";
  if (warnings.length > 0) message += (message ? "\n\n" : "") + warnings.join("\n");
  input.push({ type: "text", text: message });
  return input;
}

module.exports = {
  buildInput: buildInput,
  inspectImage: inspectImage,
  warningForImage: warningForImage,
};
