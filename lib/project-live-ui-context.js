var crypto = require("crypto");

var MAX_PACKET_BYTES = 32 * 1024;
var MAX_TEXT = 500;
var MAX_NAME = 300;
var MAX_SELECTOR = 500;
var MAX_SELECTORS = 8;
var FORBIDDEN_KEYS = {
  value: true,
  inputValue: true,
  password: true,
  cookie: true,
  cookies: true,
  authorization: true,
  headers: true,
  storage: true,
  localStorage: true,
  sessionStorage: true,
  requestBody: true,
};

function boundedString(value, max) {
  if (typeof value !== "string") return null;
  var clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.slice(0, max);
}

function scrubText(value, max) {
  var clean = boundedString(value, max);
  if (!clean) return null;
  clean = clean.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  clean = clean.replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\b/gi, "[redacted-token]");
  return clean.slice(0, max);
}

function hasForbiddenKey(value) {
  if (!value || typeof value !== "object") return false;
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    if (FORBIDDEN_KEYS[keys[i]]) return true;
    if (hasForbiddenKey(value[keys[i]])) return true;
  }
  return false;
}

function boundedNumber(value, min, max) {
  var number = Number(value);
  if (!isFinite(number)) return null;
  if (number < min || number > max) return null;
  return Math.round(number * 100) / 100;
}

function sanitizeRect(rect) {
  if (!rect || typeof rect !== "object") return null;
  var x = boundedNumber(rect.x, -100000, 100000);
  var y = boundedNumber(rect.y, -100000, 100000);
  var width = boundedNumber(rect.width, 0, 100000);
  var height = boundedNumber(rect.height, 0, 100000);
  if (x === null || y === null || width === null || height === null) return null;
  return { x: x, y: y, width: width, height: height };
}

function sanitizeSelectors(selectors) {
  if (!Array.isArray(selectors)) return [];
  var result = [];
  for (var i = 0; i < selectors.length && result.length < MAX_SELECTORS; i++) {
    var selector = boundedString(selectors[i], MAX_SELECTOR);
    if (selector) result.push(selector);
  }
  return result;
}

function sanitizeSelectionPacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { ok: false, error: "Selection packet must be an object" };
  }
  var rawSize = Buffer.byteLength(JSON.stringify(packet), "utf8");
  if (rawSize > MAX_PACKET_BYTES) {
    return { ok: false, error: "Selection packet exceeds 32 KB" };
  }
  if (hasForbiddenKey(packet)) {
    return { ok: false, error: "Selection packet contains a forbidden sensitive field" };
  }

  var tag = boundedString(packet.tag, 80);
  var route = boundedString(packet.route, 1000);
  var documentGeneration = boundedString(packet.documentGeneration, 128);
  var rect = sanitizeRect(packet.rect);
  if (!tag || !route || !documentGeneration || !rect) {
    return { ok: false, error: "Selection packet is missing required bounded metadata" };
  }

  var sanitized = {
    tag: tag.toLowerCase(),
    role: boundedString(packet.role, 120),
    text: scrubText(packet.text, MAX_TEXT),
    accessibleName: scrubText(packet.accessibleName, MAX_NAME),
    route: route,
    documentGeneration: documentGeneration,
    rect: rect,
    selectors: sanitizeSelectors(packet.selectors),
  };
  var fingerprintInput = JSON.stringify({
    tag: sanitized.tag,
    role: sanitized.role,
    text: sanitized.text,
    route: sanitized.route,
    selectors: sanitized.selectors,
  });
  sanitized.fingerprint = crypto.createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 24);
  return { ok: true, packet: sanitized };
}

module.exports = {
  MAX_PACKET_BYTES: MAX_PACKET_BYTES,
  sanitizeSelectionPacket: sanitizeSelectionPacket,
};
