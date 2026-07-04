var path = require("path");
var fs = require("fs");

function discoverClaudeSkills(cwd) {
  var skills = {};
  var REAL_HOME;
  try { REAL_HOME = require("../../config").REAL_HOME; } catch (e) { REAL_HOME = require("os").homedir(); }
  var dirs = [
    path.join(REAL_HOME, ".claude", "skills"),
    path.join(cwd || "", ".claude", "skills"),
  ];
  for (var d = 0; d < dirs.length; d++) {
    var base = dirs[d];
    if (!base) continue;
    var entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { continue; }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      var skillMd = path.join(base, entry.name, "SKILL.md");
      try {
        fs.accessSync(skillMd, fs.constants.R_OK);
        skills[entry.name] = skillMd;
      } catch (e) {}
    }
  }
  return skills;
}

function parseSkillRefs(text, availableSkills) {
  if (typeof text !== "string") return { text: text, skills: [] };
  var skills = [];
  var seen = {};
  var re = /\$([a-zA-Z0-9_-]+)/g;
  var match;
  while ((match = re.exec(text)) !== null) {
    var name = match[1];
    if (seen[name]) continue;
    if (availableSkills[name]) {
      seen[name] = true;
      skills.push({ name: name, path: availableSkills[name] });
    }
  }
  return { text: text, skills: skills };
}

module.exports = {
  discoverClaudeSkills: discoverClaudeSkills,
  parseSkillRefs: parseSkillRefs,
};
