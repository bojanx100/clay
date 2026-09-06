// Local Markdown references only. Fenced examples and template paths are not
// instructions. Required reading follows recursively; supporting references
// remain an explicit index for task-specific retrieval, never a silent summary.
var fs = require("fs");
var path = require("path");

function references(body, source) {
  var governing = /^(?:agents|claude|triage)(?:\.local)?\.md$/i.test(path.basename(source || ""));
  var result = [];
  var fence = null;
  var paragraphs = [];
  var lines = [];
  String(body).split(/\r?\n/).forEach(function (line) {
    var marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = null;
      return;
    }
    if (fence) return;
    if (/^\s*(?:[-*] |\|)/.test(line) && lines.length) { paragraphs.push(lines.join("\n")); lines = []; }
    if (!line.trim()) { if (lines.length) paragraphs.push(lines.join("\n")); lines = []; }
    else lines.push(line);
  });
  if (lines.length) paragraphs.push(lines.join("\n"));
  paragraphs.forEach(function (paragraph) {
    var required = !/^\s*\|/.test(paragraph) &&
      /\b(?:read|follow|consult|load|include|import)\b/i.test(paragraph);
    var pattern = /\]\(<?([^\s)]+\.md)(?:#[^\s)>]*)?>?(?:\s+"[^"]*")?\)|`([^`\n]+\.md)(?:#[^`\n]*)?`|(?:^|\s)@([^\s]+\.md)(?:#[^\s]*)?/gm;
    var match;
    while ((match = pattern.exec(paragraph))) {
      var value = match[1] || match[2] || match[3];
      if (/^(?:https?:|mailto:|data:)/i.test(value) || /[<>{}*$]/.test(value)) continue;
      var example = /(?:template|example)\s*:\s*`?$/i.test(paragraph.slice(0, match.index));
      result.push({ path: value, required: !example && (required || !!match[3] || governing &&
        /^(?:agents|claude|triage)(?:\.local)?\.md$/i.test(path.basename(value))) });
    }
  });
  return result;
}

function inside(root, target) {
  var relative = path.relative(root, target);
  return relative !== ".." && relative.indexOf(".." + path.sep) !== 0 && !path.isAbsolute(relative);
}

function resolveReference(root, from, value) {
  var decoded;
  try { decoded = decodeURIComponent(value); } catch (error) { return { reason: "invalid_instruction_reference" }; }
  if (path.isAbsolute(decoded) || decoded[0] === "~") return { reason: "instruction_reference_outside_project" };
  var candidates = [path.resolve(root, path.dirname(from), decoded), path.resolve(root, decoded)];
  var found = [];
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (!inside(root, candidate)) continue;
    try {
      var real = fs.realpathSync(candidate);
      if (!inside(root, real)) return { reason: "instruction_reference_outside_project" };
      if (!fs.statSync(real).isFile()) continue;
      if (found.indexOf(real) === -1) found.push(real);
    } catch (error) { if (error.code !== "ENOENT") return { reason: "project_instructions_unreadable" }; }
  }
  if (found.length > 1) return { reason: "ambiguous_instruction_reference" };
  if (!found.length) return { reason: candidates.some(function (candidate) { return inside(root, candidate); }) ?
    "project_instruction_reference_missing" : "instruction_reference_outside_project" };
  return { path: path.relative(root, found[0]).split(path.sep).join("/") };
}

module.exports = { references: references, resolveReference: resolveReference, inside: inside };
