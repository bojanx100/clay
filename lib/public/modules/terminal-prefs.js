// terminal-prefs.js
//
// Single source of truth for terminal font preferences (family + size).
// Every xterm in Clay (bottom shell panel, Claude TUI session view, TUI
// attention modal) reads from here on create and re-applies on the
// `font-change` event so live updates are seamless.
//
// Persistence lives server-side under the user's profile. This module
// keeps a synchronized in-memory copy that the rest of the client reads
// without round-trips.

var DEFAULT_FAMILY = "'SF Mono', Menlo, Monaco, 'Courier New', monospace";
var DEFAULT_SIZE = 14;

var currentFamily = DEFAULT_FAMILY;
var currentSize = DEFAULT_SIZE;
var listeners = [];

// D2 Coding ships ~1.4MB of CJK glyphs per weight, so we avoid loading
// it eagerly on every page. The link is injected on demand the first
// time the user actually picks the font (or boots with it saved). The
// @font-face in this CSS registers under the family 'D2 coding' and
// also picks up a locally-installed 'D2Coding' via local() fallback.
//
// xterm's WebGL renderer measures cell metrics synchronously when the
// font family option changes, so the first atlas build right after
// selection happens against the *fallback* (SF Mono for Latin, a system
// Hangul font for Korean). Each is measured with its own width, so
// Latin and Hangul cells fall out of the expected 1:2 ratio and lines
// stop lining up. After the woff2 actually arrives we replay the
// font-change notification so every listener rebuilds its atlas with
// the proper D2 Coding metrics for both scripts.
var injectedFontStylesheets = {};
function notifyFontListeners() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](currentFamily, currentSize); } catch (e) {}
  }
}
function ensureD2CodingWebfont() {
  var url = "https://cdn.jsdelivr.net/gh/Joungkyun/font-d2coding/d2coding.css";
  if (injectedFontStylesheets[url]) return;
  injectedFontStylesheets[url] = true;
  if (typeof document === "undefined" || !document.head) return;
  var link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.onload = function () {
    if (document.fonts && typeof document.fonts.load === "function") {
      Promise.all([
        document.fonts.load('400 16px "D2 coding"'),
        document.fonts.load('700 16px "D2 coding"'),
      ]).then(notifyFontListeners).catch(function () {});
    } else {
      notifyFontListeners();
    }
  };
  document.head.appendChild(link);
}

var googleFontFamilies = {
  "jetbrains mono": "JetBrains+Mono",
  "fira code": "Fira+Code",
  "cascadia code": "Cascadia+Code",
  "ibm plex mono": "IBM+Plex+Mono",
  "source code pro": "Source+Code+Pro",
};

function ensureGoogleTerminalFont(lower) {
  var keys = Object.keys(googleFontFamilies);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (lower.indexOf(key) === -1) continue;
    var url = "https://fonts.googleapis.com/css2?family=" + googleFontFamilies[key] +
      ":wght@400;500;700&display=swap";
    if (injectedFontStylesheets[url]) return;
    injectedFontStylesheets[url] = true;
    if (typeof document === "undefined" || !document.head) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.onload = function () {
      if (document.fonts && typeof document.fonts.load === "function") {
        Promise.all([
          document.fonts.load('400 16px "' + key + '"'),
          document.fonts.load('700 16px "' + key + '"'),
        ]).then(notifyFontListeners).catch(function () {});
      } else {
        notifyFontListeners();
      }
    };
    document.head.appendChild(link);
    return;
  }
}

function maybeLazyLoadWebfont(family) {
  if (typeof family !== "string") return;
  var lower = family.toLowerCase();
  if (lower.indexOf("d2 coding") !== -1 || lower.indexOf("d2coding") !== -1) {
    ensureD2CodingWebfont();
    return;
  }
  ensureGoogleTerminalFont(lower);
}

export function getTerminalFontFamily() {
  return currentFamily || DEFAULT_FAMILY;
}

export function getTerminalFontSize() {
  var n = Number(currentSize);
  return (n >= 9 && n <= 32) ? n : DEFAULT_SIZE;
}

export function getDefaultTerminalFontFamily() {
  return DEFAULT_FAMILY;
}

// Set the in-memory values and notify subscribers. Pass null/undefined
// for any field that should stay unchanged. Persisting to the server
// is the caller's responsibility - this only updates local UI.
export function applyTerminalFont(family, size) {
  var changed = false;
  if (typeof family === "string" && family.trim() && family !== currentFamily) {
    currentFamily = family;
    changed = true;
  }
  if (typeof size === "number" && size >= 9 && size <= 32 && size !== currentSize) {
    currentSize = Math.round(size);
    changed = true;
  }
  if (!changed) return;
  maybeLazyLoadWebfont(currentFamily);
  notifyFontListeners();
}

export function onTerminalFontChange(fn) {
  if (typeof fn === "function") listeners.push(fn);
}
