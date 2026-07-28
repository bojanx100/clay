var crypto = require("crypto");

var MAX_PACKET_BYTES = 32 * 1024;
var MAX_TEXT = 500;
var MAX_NAME = 300;
var MAX_SELECTOR = 500;
var MAX_SELECTORS = 8;
var MAX_COMPONENT_CHAIN = 8;
var MAX_DIAGNOSTIC_BYTES = 32 * 1024;
var MAX_CONSOLE_ENTRIES = 24;
var MAX_NETWORK_ENTRIES = 40;
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

function safeSourcePath(value) {
  var clean = boundedString(value, 1000);
  if (!clean) return null;
  try {
    if (/^(?:https?|file):/i.test(clean)) clean = new URL(clean).pathname;
  } catch (e) {}
  clean = clean.replace(/\\/g, "/").split(/[?#]/)[0];
  var parts = clean.split("/").filter(function (part) {
    return part && part !== "." && part !== "..";
  });
  var markers = ["src", "app", "pages", "components"];
  var markerIndex = -1;
  for (var i = 0; i < parts.length; i++) {
    if (markers.indexOf(parts[i]) !== -1) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex !== -1) parts = parts.slice(markerIndex);
  else if (parts.length > 6) parts = parts.slice(parts.length - 6);
  return parts.join("/").slice(0, 700) || null;
}

function sanitizeComponent(component) {
  if (!component || typeof component !== "object" || Array.isArray(component)) {
    return null;
  }
  var framework = boundedString(component.framework, 30);
  var name = boundedString(component.name, 160);
  if (framework !== "react" || !name) return null;
  var chain = [];
  var rawChain = Array.isArray(component.chain) ? component.chain : [];
  for (var i = 0; i < rawChain.length && chain.length < MAX_COMPONENT_CHAIN; i++) {
    var chainName = boundedString(rawChain[i], 160);
    if (chainName) chain.push(chainName);
  }
  var source = component.source && typeof component.source === "object" ? {
    file: safeSourcePath(component.source.file),
    line: boundedNumber(component.source.line, 1, 10000000),
    column: boundedNumber(component.source.column, 1, 100000),
  } : null;
  if (source && !source.file) source = null;
  var componentId = crypto.createHash("sha256").update(JSON.stringify({
    framework: framework,
    name: name,
    chain: chain,
    source: source && source.file,
  })).digest("hex").slice(0, 20);
  return {
    framework: framework,
    name: name,
    chain: chain,
    source: source,
    componentId: componentId,
  };
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
    component: sanitizeComponent(packet.component),
  };
  var fingerprintInput = JSON.stringify({
    tag: sanitized.tag,
    role: sanitized.role,
    text: sanitized.text,
    route: sanitized.route,
    selectors: sanitized.selectors,
    componentId: sanitized.component && sanitized.component.componentId,
  });
  sanitized.fingerprint = crypto.createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 24);
  return { ok: true, packet: sanitized };
}

function sanitizeUrl(value) {
  var clean = boundedString(value, 1200);
  if (!clean) return null;
  try {
    var parsed = new URL(clean, "http://relative.invalid");
    var path = parsed.pathname || "/";
    return parsed.origin === "http://relative.invalid" ?
      path : parsed.origin + path;
  } catch (e) {
    return scrubText(clean.split(/[?#]/)[0], 1000);
  }
}

function sanitizeDiagnosticsPacket(packet) {
  if (!packet) return { ok: true, packet: { console: [], network: [] } };
  if (typeof packet !== "object" || Array.isArray(packet)) {
    return { ok: false, error: "Diagnostics packet must be an object" };
  }
  var rawSize = Buffer.byteLength(JSON.stringify(packet), "utf8");
  if (rawSize > MAX_DIAGNOSTIC_BYTES || hasForbiddenKey(packet)) {
    return { ok: false, error: "Diagnostics packet is unsafe or exceeds 32 KB" };
  }
  var consoleEntries = [];
  var sourceConsole = Array.isArray(packet.console) ? packet.console : [];
  for (var i = 0; i < sourceConsole.length && consoleEntries.length < MAX_CONSOLE_ENTRIES; i++) {
    var entry = sourceConsole[i] || {};
    var text = scrubText(entry.text, 600);
    if (!text) continue;
    consoleEntries.push({
      level: boundedString(entry.level, 20) || "log",
      text: text,
    });
  }
  var networkEntries = [];
  var sourceNetwork = Array.isArray(packet.network) ? packet.network : [];
  for (var j = 0; j < sourceNetwork.length && networkEntries.length < MAX_NETWORK_ENTRIES; j++) {
    var request = sourceNetwork[j] || {};
    var url = sanitizeUrl(request.url);
    if (!url) continue;
    networkEntries.push({
      method: boundedString(request.method, 12) || "GET",
      url: url,
      status: boundedNumber(request.status, 0, 999),
      duration: boundedNumber(request.duration, 0, 3600000),
      error: scrubText(request.error, 300),
    });
  }
  return {
    ok: true,
    packet: {
      console: consoleEntries,
      network: networkEntries,
    },
  };
}

module.exports = {
  MAX_PACKET_BYTES: MAX_PACKET_BYTES,
  sanitizeDiagnosticsPacket: sanitizeDiagnosticsPacket,
  sanitizeSelectionPacket: sanitizeSelectionPacket,
};
