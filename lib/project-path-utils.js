var fs = require("fs");
var path = require("path");

var IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "__pycache__", ".cache", "dist", "build", ".clay", ".claude-relay"]);
var BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".pyc", ".o", ".a", ".class",
]);
var IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
var FS_MAX_SIZE = 512 * 1024;

function validateEnvString(str) {
  if (!str || !str.trim()) return null;
  var lines = str.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    var eqIdx = line.indexOf("=");
    if (eqIdx < 1) return "Invalid format at line " + (i + 1) + ": expected KEY=VALUE";
    var key = line.substring(0, eqIdx);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      return "Invalid variable name at line " + (i + 1) + ": " + key;
    }
    var value = line.substring(eqIdx + 1);
    if (/[`$\\;|&><(){}\n]/.test(value) && !/^["'].*["']$/.test(value)) {
      return "Potentially unsafe value at line " + (i + 1) + ": shell metacharacters detected";
    }
  }
  return null;
}

function safePath(base, requested) {
  var resolved = path.resolve(base, requested);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  try {
    var real = fs.realpathSync(resolved);
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    return real;
  } catch (e) {
    return null;
  }
}

function safeAbsPath(requested) {
  if (!requested) return null;
  var resolved = path.resolve(requested);
  try {
    return fs.realpathSync(resolved);
  } catch (e) {
    return null;
  }
}

module.exports = {
  IGNORED_DIRS: IGNORED_DIRS,
  BINARY_EXTS: BINARY_EXTS,
  IMAGE_EXTS: IMAGE_EXTS,
  FS_MAX_SIZE: FS_MAX_SIZE,
  validateEnvString: validateEnvString,
  safePath: safePath,
  safeAbsPath: safeAbsPath,
};
