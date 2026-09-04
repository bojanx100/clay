var fs = require("fs");
var path = require("path");
var validateEnvString = require("./runtime-env").validateEnvString;

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

function resolveCreateProjectRequest(msg, realHome) {
  var requestedPath = String(msg && msg.path || "").trim();
  if (requestedPath) {
    var expandedPath = requestedPath.replace(/^~(?=\/|$)/, realHome);
    if (!path.isAbsolute(expandedPath)) {
      return { error: "Project folder must be an absolute path." };
    }
    var requestedName = path.basename(expandedPath);
    if (!requestedName || requestedName === "." || requestedName === ".." || /[\0-\x1f]/.test(requestedName)) {
      return { error: "Invalid project folder name." };
    }
    var targetPath;
    try { targetPath = path.resolve(expandedPath); } catch (e) {
      return { error: "Invalid project folder path." };
    }
    var projectName = path.basename(targetPath);
    return {
      name: projectName,
      parentPath: path.dirname(targetPath),
      targetPath: targetPath,
    };
  }
  var legacyName = String(msg && msg.name || "").trim();
  if (!legacyName || !/^[a-zA-Z0-9_-]+$/.test(legacyName)) {
    return { error: "Invalid name. Use only letters, numbers, dashes, and underscores." };
  }
  return { name: legacyName, parentPath: null, targetPath: null };
}

function isPathInside(base, target) {
  var resolvedBase = path.resolve(base);
  var resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

module.exports = {
  IGNORED_DIRS: IGNORED_DIRS,
  BINARY_EXTS: BINARY_EXTS,
  IMAGE_EXTS: IMAGE_EXTS,
  FS_MAX_SIZE: FS_MAX_SIZE,
  validateEnvString: validateEnvString,
  safePath: safePath,
  safeAbsPath: safeAbsPath,
  resolveCreateProjectRequest: resolveCreateProjectRequest,
  isPathInside: isPathInside,
};
