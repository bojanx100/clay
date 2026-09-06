var fs = require("fs");
var path = require("path");
var imageDimensions = require("./yoke/adapters/claude-image-input").imageDimensions;
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function isImage(part) {
  return !!part && (part.type === "image" || part.type === "local_image");
}

function localImage(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  var fd;
  try {
    fd = fs.openSync(file, "r");
    var stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || !stat.size) return null;
    var bytes = Buffer.alloc(stat.size);
    var offset = 0;
    while (offset < bytes.length) {
      var count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return null;
      offset += count;
    }
    for (var i = 0; i < MEDIA_TYPES.length; i++) {
      if (imageDimensions(MEDIA_TYPES[i], bytes)) return { mediaType: MEDIA_TYPES[i], data: bytes.toString("base64") };
    }
  } catch (e) { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

function embeddedImage(url) {
  if (typeof url !== "string" || url.length > MAX_IMAGE_BYTES * 4 / 3 + 100) return null;
  var match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function read(payload) {
  var parts = Array.isArray(payload.imageContent) ? payload.imageContent.slice() : [];
  (Array.isArray(payload.images) ? payload.images : []).forEach(function (url) { parts.push({ type: "image", url: url }); });
  (Array.isArray(payload.local_images) ? payload.local_images : []).forEach(function (file) { parts.push({ type: "local_image", path: file }); });
  var images = [];
  var unavailable = [];
  parts.forEach(function (part) {
    if (!isImage(part)) return;
    var image = part.type === "local_image" ? localImage(part.path) : embeddedImage(part.url);
    if (image) images.push(image);
    else unavailable.push(part.type === "local_image" && typeof part.path === "string" ? path.basename(part.path) : "image");
  });
  return { images: images, unavailable: unavailable };
}

module.exports = { isImage: isImage, read: read };
