var fs = require("fs");
var path = require("path");

/**
 * Attach file/directory watcher engine to a project context.
 *
 * ctx fields:
 *   cwd, send, sendTo, safePath, BINARY_EXTS, FS_MAX_SIZE, IGNORED_DIRS
 */
function attachFileWatch(ctx) {
  var cwd = ctx.cwd;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var safePath = ctx.safePath;
  var BINARY_EXTS = ctx.BINARY_EXTS;
  var FS_MAX_SIZE = ctx.FS_MAX_SIZE;
  var IGNORED_DIRS = ctx.IGNORED_DIRS;

  // --- File watcher ---
  // One open file per websocket client. A project-wide singleton watcher made
  // one browser tab silently replace another tab's live preview subscription.
  var fileWatchers = new Map();

  function closeFileWatch(key) {
    var entry = fileWatchers.get(key);
    if (!entry) return;
    clearTimeout(entry.debounce);
    try { entry.watcher.close(); } catch (e) {}
    fileWatchers.delete(key);
  }

  function sendFileChanged(client, message) {
    if (client && typeof sendTo === "function") {
      sendTo(client, message);
    } else {
      send(message);
    }
  }

  function startFileWatch(client, relPath) {
    // Preserve the old single-argument API for callers outside the websocket
    // file browser. They share one legacy subscription.
    if (typeof relPath !== "string") {
      relPath = client;
      client = null;
    }
    var absPath = safePath(cwd, relPath);
    if (!absPath) return;
    var key = client || "_legacy";
    var existing = fileWatchers.get(key);
    if (existing && existing.relPath === relPath) return;
    closeFileWatch(key);

    // Watch the parent directory rather than the file inode. Editors and agent
    // tools commonly save with write-temp + rename; watching the old inode then
    // misses later edits even though the path still exists.
    var parentPath = path.dirname(absPath);
    var baseName = path.basename(absPath);
    try {
      var watcher = fs.watch(parentPath, function (eventType, filename) {
        if (filename && String(filename) !== baseName) return;
        var active = fileWatchers.get(key);
        if (!active || active.relPath !== relPath) return;
        clearTimeout(active.debounce);
        active.debounce = setTimeout(function () {
          var latest = fileWatchers.get(key);
          if (!latest || latest.relPath !== relPath) return;
          try {
            var stat = fs.statSync(absPath);
            var ext = path.extname(absPath).toLowerCase();
            if (stat.size > FS_MAX_SIZE || BINARY_EXTS.has(ext)) return;
            var content = fs.readFileSync(absPath, "utf8");
            sendFileChanged(client, { type: "fs_file_changed", path: relPath, content: content, size: stat.size });
          } catch (e) {
            // Atomic saves can briefly remove the destination path between
            // rename events. Keep the parent watcher alive for the next event.
            if (e.code !== "ENOENT") closeFileWatch(key);
          }
        }, 200);
      });
      fileWatchers.set(key, { watcher: watcher, relPath: relPath, debounce: null });
      watcher.on("error", function () { closeFileWatch(key); });
    } catch (e) {
      closeFileWatch(key);
    }
  }

  function stopFileWatch(client) {
    if (arguments.length > 0) {
      closeFileWatch(client || "_legacy");
      return;
    }
    var keys = Array.from(fileWatchers.keys());
    for (var i = 0; i < keys.length; i++) closeFileWatch(keys[i]);
  }

  // --- Directory watcher ---
  var dirWatchers = {};  // relPath -> { watcher, debounce }

  function startDirWatch(relPath) {
    if (dirWatchers[relPath]) return;
    var absPath = safePath(cwd, relPath);
    if (!absPath) return;
    try {
      var debounce = null;
      var watcher = fs.watch(absPath, function () {
        clearTimeout(debounce);
        debounce = setTimeout(function () {
          // Re-read directory and broadcast to all clients
          try {
            var items = fs.readdirSync(absPath, { withFileTypes: true });
            var entries = [];
            for (var i = 0; i < items.length; i++) {
              if (items[i].isDirectory() && IGNORED_DIRS.has(items[i].name)) continue;
              entries.push({
                name: items[i].name,
                type: items[i].isDirectory() ? "dir" : "file",
                path: path.relative(cwd, path.join(absPath, items[i].name)).split(path.sep).join("/"),
              });
            }
            send({ type: "fs_dir_changed", path: relPath, entries: entries });
          } catch (e) {
            stopDirWatch(relPath);
          }
        }, 300);
      });
      watcher.on("error", function () { stopDirWatch(relPath); });
      dirWatchers[relPath] = { watcher: watcher, debounce: debounce };
    } catch (e) {}
  }

  function stopDirWatch(relPath) {
    var entry = dirWatchers[relPath];
    if (entry) {
      clearTimeout(entry.debounce);
      try { entry.watcher.close(); } catch (e) {}
      delete dirWatchers[relPath];
    }
  }

  function stopAllDirWatches() {
    var paths = Object.keys(dirWatchers);
    for (var i = 0; i < paths.length; i++) {
      stopDirWatch(paths[i]);
    }
  }

  return {
    startFileWatch: startFileWatch,
    stopFileWatch: stopFileWatch,
    startDirWatch: startDirWatch,
    stopDirWatch: stopDirWatch,
    stopAllDirWatches: stopAllDirWatches,
  };
}

module.exports = { attachFileWatch: attachFileWatch };
