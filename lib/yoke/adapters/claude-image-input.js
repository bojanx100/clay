var MAX_MANY_IMAGE_DIMENSION = 2000;
var SUPPORTED_MEDIA_TYPES = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes) {
  var header = bytes.length >= 10 ? bytes.toString("ascii", 0, 6) : "";
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function isJpeg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function nextJpegMarker(bytes, offset) {
  if (bytes[offset] !== 0xff) return null;
  while (offset < bytes.length && bytes[offset] === 0xff) offset++;
  return offset < bytes.length ? { marker: bytes[offset], offset: offset + 1 } : null;
}

function isStandaloneJpegMarker(marker) {
  return marker === 0xd8 || marker === 0x01;
}

function isTerminalJpegMarker(marker) {
  return marker === 0xd9 || marker === 0xda;
}

function isJpegStartOfFrame(marker) {
  return marker >= 0xc0 && marker <= 0xcf &&
    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(bytes) {
  if (!isJpeg(bytes)) return null;
  var offset = 2;
  while (offset + 3 < bytes.length) {
    var next = nextJpegMarker(bytes, offset);
    if (!next) return null;
    offset = next.offset;
    if (isStandaloneJpegMarker(next.marker)) continue;
    if (isTerminalJpegMarker(next.marker) || offset + 1 >= bytes.length) return null;
    var length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isJpegStartOfFrame(next.marker)) {
      if (length < 7) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function uint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes) {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  var format = bytes.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return { width: uint24LE(bytes, 24) + 1, height: uint24LE(bytes, 27) + 1 };
  }
  if (format === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  if (format === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function imageDimensions(mediaType, bytes) {
  if (mediaType === "image/png") return pngDimensions(bytes);
  if (mediaType === "image/jpeg") return jpegDimensions(bytes);
  if (mediaType === "image/gif") return gifDimensions(bytes);
  if (mediaType === "image/webp") return webpDimensions(bytes);
  return null;
}

function inspectImage(image) {
  var candidate = image || {};
  var imagePath = typeof candidate.savedPath === "string" ? candidate.savedPath : null;
  if (!SUPPORTED_MEDIA_TYPES[candidate.mediaType] || typeof candidate.data !== "string" || !candidate.data) {
    return { ok: false, reason: "unsupported or unavailable image data", path: imagePath };
  }
  var bytes;
  try {
    bytes = Buffer.from(candidate.data, "base64");
  } catch (e) {
    return { ok: false, reason: "invalid base64 image data", path: imagePath };
  }
  var dimensions = imageDimensions(candidate.mediaType, bytes);
  if (!dimensions || !dimensions.width || !dimensions.height) {
    return { ok: false, reason: "image dimensions could not be verified", path: imagePath };
  }
  if (dimensions.width > MAX_MANY_IMAGE_DIMENSION || dimensions.height > MAX_MANY_IMAGE_DIMENSION) {
    return {
      ok: false,
      reason: dimensions.width + "x" + dimensions.height +
        " exceeds Claude's 2000-pixel many-image limit",
      path: imagePath,
      dimensions: dimensions,
    };
  }
  return { ok: true, path: imagePath, dimensions: dimensions };
}

function warningForImage(index, inspection) {
  var location = inspection.path ?
    " View the preserved original with the file-reading tool: " + inspection.path + "." :
    " The original attachment remains in Clay, but no local path was available.";
  return "[Clay did not embed image attachment " + (index + 1) +
    " in Claude's conversation history: " + inspection.reason + "." + location + "]";
}

function providerImage(image) {
  var candidate = image || {};
  if (typeof candidate.providerData !== "string" || !candidate.providerData) return candidate;
  return {
    mediaType: candidate.providerMediaType || candidate.mediaType,
    data: candidate.providerData,
    savedPath: candidate.savedPath,
  };
}

function buildContent(text, images) {
  var content = [];
  var warnings = [];
  var attachments = Array.isArray(images) ? images : [];
  for (var i = 0; i < attachments.length; i++) {
    var directImage = providerImage(attachments[i]);
    var inspection = inspectImage(directImage);
    if (inspection.ok) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: directImage.mediaType,
          data: directImage.data,
        },
      });
    } else {
      warnings.push(warningForImage(i, inspection));
    }
  }
  var message = text || "";
  if (warnings.length > 0) message += (message ? "\n\n" : "") + warnings.join("\n");
  if (message) content.push({ type: "text", text: message });
  return content;
}

module.exports = {
  MAX_MANY_IMAGE_DIMENSION: MAX_MANY_IMAGE_DIMENSION,
  buildContent: buildContent,
  imageDimensions: imageDimensions,
  inspectImage: inspectImage,
  providerImage: providerImage,
  warningForImage: warningForImage,
};
