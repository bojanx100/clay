var fs = require("fs");

// Identity checks need only the first record, even for a very large rollout.
// Accumulate bytes until the newline so chunk boundaries cannot corrupt UTF-8.
function read(file) {
  var fd;
  try {
    fd = fs.openSync(file, "r");
    var parts = [];
    var total = 0;
    while (total < 4 * 1024 * 1024) {
      var buffer = Buffer.alloc(64 * 1024);
      var count = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (!count) break;
      total += count;
      var bytes = buffer.subarray(0, count);
      var newline = bytes.indexOf(10);
      parts.push(newline === -1 ? bytes : bytes.subarray(0, newline));
      if (newline !== -1) return JSON.parse(Buffer.concat(parts).toString("utf8"));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (e) { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { read: read };
