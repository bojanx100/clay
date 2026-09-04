var path = require("path");

var MAX_IMAGES = 4;
var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
var MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
var MAX_PASTES = 4;
var MAX_PASTE_CHARS = 64 * 1024;
var MAX_TOTAL_PASTE_CHARS = 128 * 1024;
var IMAGE_TYPES = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};

function validSignature(mediaType, decoded) {
  if (mediaType === "image/png") {
    return decoded.length >= 8 &&
      decoded.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  }
  if (mediaType === "image/jpeg") {
    return decoded.length >= 3 && decoded.subarray(0, 3).toString("hex") === "ffd8ff";
  }
  if (mediaType === "image/gif") {
    var gif = decoded.length >= 6 ? decoded.subarray(0, 6).toString("ascii") : "";
    return gif === "GIF87a" || gif === "GIF89a";
  }
  return decoded.length >= 12 &&
    decoded.subarray(0, 4).toString("ascii") === "RIFF" &&
    decoded.subarray(8, 12).toString("ascii") === "WEBP";
}

function safeName(value, index) {
  var name = typeof value === "string" ? path.basename(value.replace(/\0/g, "")) : "";
  name = name.replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 120);
  return name || "pasted-image-" + (index + 1);
}

function failure(error) {
  return { ok: false, error: error };
}

function sanitizeAttachments(payload) {
  if (!payload) return { ok: true, packet: { images: [], pastes: [] } };
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return failure("Live UI attachments must be an object");
  }
  var sourceImages = payload.images === undefined ? [] : payload.images;
  var sourcePastes = payload.pastes === undefined ? [] : payload.pastes;
  if (!Array.isArray(sourceImages) || !Array.isArray(sourcePastes) ||
      sourceImages.length > MAX_IMAGES || sourcePastes.length > MAX_PASTES) {
    return failure("Live UI supports up to four pasted images and four text pastes");
  }
  var images = [];
  var totalImageBytes = 0;
  for (var i = 0; i < sourceImages.length; i++) {
    var image = sourceImages[i];
    var data = image && typeof image.data === "string" ? image.data : "";
    if (!image || !IMAGE_TYPES[image.mediaType] || !data ||
        data.length > 7 * 1024 * 1024 || data.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return failure("A pasted image is invalid or uses an unsupported format");
    }
    var decoded = Buffer.from(data, "base64");
    if (!decoded.length || decoded.length > MAX_IMAGE_BYTES ||
        !validSignature(image.mediaType, decoded)) {
      return failure("A pasted image failed validation or exceeds 5 MB");
    }
    totalImageBytes += decoded.length;
    if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      return failure("Pasted images exceed the 10 MB total limit");
    }
    images.push({
      mediaType: image.mediaType,
      data: data,
      name: safeName(image.name, i),
    });
  }
  var pastes = [];
  var totalPasteChars = 0;
  for (var j = 0; j < sourcePastes.length; j++) {
    if (typeof sourcePastes[j] !== "string" || !sourcePastes[j]) {
      return failure("A pasted text attachment is invalid");
    }
    var paste = sourcePastes[j].replace(/\0/g, "");
    if (paste.length > MAX_PASTE_CHARS) {
      return failure("Each pasted text attachment must be under 64 KB");
    }
    totalPasteChars += paste.length;
    if (totalPasteChars > MAX_TOTAL_PASTE_CHARS) {
      return failure("Pasted text exceeds the 128 KB total limit");
    }
    pastes.push(paste);
  }
  return { ok: true, packet: { images: images, pastes: pastes } };
}

function storeImages(packet, ctx, session) {
  var refs = [];
  var owner = ctx.getLinuxUserForSession ? ctx.getLinuxUserForSession(session) : null;
  for (var i = 0; i < packet.images.length; i++) {
    var image = packet.images[i];
    var file = ctx.saveImageFile(image.mediaType, image.data, owner);
    if (!file) {
      var error = new Error("Clay could not store a pasted Live UI image");
      error.code = "LIVE_UI_ATTACHMENT_STORE_FAILED";
      throw error;
    }
    refs.push({ mediaType: image.mediaType, file: file });
  }
  return refs;
}

function attachmentContext(packet) {
  if (!packet.images.length && !packet.pastes.length) return "No user-pasted attachments.";
  var lines = ["User-pasted context supplied with this report:"];
  if (packet.images.length) {
    lines.push("- " + packet.images.length + " pasted image" +
      (packet.images.length === 1 ? " is" : "s are") +
      " attached after the automatic viewport screenshot.");
    for (var i = 0; i < packet.images.length; i++) {
      lines.push("  " + (i + 1) + ". " + packet.images[i].name);
    }
  }
  for (var j = 0; j < packet.pastes.length; j++) {
    lines.push("");
    lines.push("Pasted text " + (j + 1) + ":");
    lines.push("--- pasted context begins ---");
    lines.push(packet.pastes[j]);
    lines.push("--- pasted context ends ---");
  }
  return lines.join("\n");
}

module.exports = {
  attachmentContext: attachmentContext,
  sanitizeAttachments: sanitizeAttachments,
  storeImages: storeImages,
};
