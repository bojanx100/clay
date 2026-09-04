export function editCodeSummary(oldStr, newStr) {
  var oldLines = oldStr ? oldStr.split("\n") : [];
  var newLines = newStr ? newStr.split("\n") : [];
  var oldSet = {};
  for (var i = 0; i < oldLines.length; i++) {
    var trimmed = oldLines[i].trim();
    if (trimmed) oldSet[trimmed] = true;
  }
  for (var j = 0; j < newLines.length; j++) {
    var line = newLines[j].trim();
    if (line && !oldSet[line] && line.length > 2) {
      if (line.length > 80) line = line.substring(0, 80) + "...";
      return "+ " + line;
    }
  }
  var newSet = {};
  for (var k = 0; k < newLines.length; k++) {
    var t = newLines[k].trim();
    if (t) newSet[t] = true;
  }
  for (var l = 0; l < oldLines.length; l++) {
    var oLine = oldLines[l].trim();
    if (oLine && !newSet[oLine] && oLine.length > 2) {
      if (oLine.length > 80) oLine = oLine.substring(0, 80) + "...";
      return "- " + oLine;
    }
  }
  return null;
}

export function describeEntry(entry) {
  if (entry.source === "git") return entry.hash.substring(0, 7) + " " + (entry.message || "").substring(0, 40);
  return (entry.sessionTitle || "Untitled") + " (" + (entry.toolName || "Edit") + ")";
}

export function shortEntryLabel(entry) {
  if (entry.source === "git") {
    var msg = (entry.message || "").substring(0, 24);
    if ((entry.message || "").length > 24) msg += "...";
    return entry.hash.substring(0, 7) + " " + msg;
  }
  return (entry.assistantSnippet || entry.toolName || "Edit").substring(0, 30);
}

export function formatTimeAgo(ts) {
  if (!ts) return "";
  var diff = Date.now() - ts;
  if (diff < 60000) return ", just now";
  if (diff < 3600000) return ", " + Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return ", " + Math.floor(diff / 3600000) + "h ago";
  var d = new Date(ts);
  return ", " + d.toLocaleDateString();
}
