var fs = require("fs");
var path = require("path");

function attachMateClaudeWatcher(ctx) {
  var cwd = ctx.cwd;
  var isMate = !!ctx.isMate;
  var projectOwnerId = ctx.projectOwnerId;
  var matesModule = ctx.matesModule;
  var nm = ctx.nm;
  var getProjectList = ctx.getProjectList;
  var crisisWatcher = null;
  var crisisDebounce = null;

  if (!isMate) {
    return {
      watcher: null,
    };
  }

  var claudeMdPath = path.join(cwd, "CLAUDE.md");
  var mateId = path.basename(cwd);
  var mateCtx = matesModule.buildMateCtx(projectOwnerId);
  var projectList = (getProjectList() || []).filter(function (p) { return !p.isMate; });
  var enforceOpts = { ctx: mateCtx, mateId: mateId, projects: projectList };
  var selfWrite = false;

  try { selfWrite = !!matesModule.enforceAllSections(claudeMdPath, enforceOpts); } catch (e) {}

  try {
    var knDir = path.join(cwd, "knowledge");
    var knFile = path.join(knDir, "sticky-notes.md");
    var notesText = nm.getActiveNotesText();
    if (notesText) {
      fs.mkdirSync(knDir, { recursive: true });
      fs.writeFileSync(knFile, notesText);
    } else {
      try { fs.unlinkSync(knFile); } catch (e) {}
    }
  } catch (e) {}

  try {
    crisisWatcher = fs.watch(claudeMdPath, function () {
      if (crisisDebounce) clearTimeout(crisisDebounce);
      crisisDebounce = setTimeout(function () {
        crisisDebounce = null;
        if (selfWrite) { selfWrite = false; return; }
        try { selfWrite = !!matesModule.enforceAllSections(claudeMdPath, enforceOpts); } catch (e) {}
      }, 500);
    });
    crisisWatcher.on("error", function () {});
  } catch (e) {}

  return {
    watcher: crisisWatcher,
  };
}

module.exports = {
  attachMateClaudeWatcher: attachMateClaudeWatcher,
};
