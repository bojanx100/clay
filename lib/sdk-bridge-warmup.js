var fs = require("fs");
var execFileSync = require("child_process").execFileSync;
var { withClaudeFallbackModels } = require("./claude-defaults");
var { listProviderRoutes } = require("./provider-routes");

function attachBridgeWarmup(ctx) {
  var adapter = ctx.adapter;
  var adapters = ctx.adapters;
  var sm = ctx.sm;
  var send = ctx.send;
  var cwd = ctx.cwd;
  var dangerouslySkipPermissions = ctx.dangerouslySkipPermissions;
  var clayPort = ctx.clayPort;
  var clayTls = ctx.clayTls;
  var clayAuthToken = ctx.clayAuthToken;
  var slug = ctx.slug;
  var discoverSkillDirs = ctx.discoverSkillDirs;
  var mergeSkills = ctx.mergeSkills;
  var getModelsForVendor = ctx.getModelsForVendor;

  function detectInstalledVendors(linuxUser) {
    var result = [];

    function tryLookup(name) {
      try {
        if (linuxUser) {
          execFileSync("su", ["-", linuxUser, "-c", "which " + name], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
        } else {
          if (process.platform === "win32") execFileSync("where", [name], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
          else execFileSync("which", [name], { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    var claudeBin = null;
    try {
      var claudeAdapter = require("./yoke/adapters/claude");
      if (claudeAdapter.resolveClaudeBinaryPath) claudeBin = claudeAdapter.resolveClaudeBinaryPath();
    } catch (e) {}
    if ((claudeBin && fs.existsSync(claudeBin)) || tryLookup("claude")) result.push("claude");

    var codexBin = null;
    try {
      codexBin = require("./yoke/codex-app-server").findCodexPath();
    } catch (e) {}
    if ((codexBin && fs.existsSync(codexBin)) || tryLookup("codex")) result.push("codex");

    var copilotBin = null;
    if (!linuxUser) {
      try { copilotBin = require("./yoke/adapters/github-copilot").findCopilotPath(); } catch (e) {}
    }
    if ((copilotBin && fs.existsSync(copilotBin)) || tryLookup("copilot")) result.push("github-copilot");

    return result;
  }

  async function warmup(linuxUser) {
    var defaultVendor = adapter ? adapter.vendor : "claude";
    sm.defaultVendor = defaultVendor;

    if (adapter) {
      try {
        var result = await adapter.init({
          cwd: cwd,
          dangerouslySkipPermissions: dangerouslySkipPermissions,
          linuxUser: linuxUser || undefined,
          clayPort: clayPort,
          clayTls: clayTls,
          clayAuthToken: clayAuthToken,
          slug: slug,
        });

        var fsSkills = discoverSkillDirs();
        sm.skillNames = mergeSkills(result.skills, fsSkills);
        if (result.slashCommands) {
          var seen = new Set();
          var combined = [];
          var all = result.slashCommands.concat(Array.from(sm.skillNames));
          for (var k = 0; k < all.length; k++) {
            if (!seen.has(all[k])) {
              seen.add(all[k]);
              combined.push(all[k]);
            }
          }
          sm.slashCommands = combined;
          sm.setSlashCommandsForVendor(defaultVendor, combined);
          send({ type: "slash_commands", commands: combined, vendor: defaultVendor });
        }
        if (result.defaultModel) {
          sm.currentModel = sm.currentModel || sm._savedDefaultModel || result.defaultModel;
        }
        sm.availableModels = result.models || [];
        sm.modelsByVendor = sm.modelsByVendor || {};
        sm.modelsByVendor[defaultVendor] = defaultVendor === "claude" ? withClaudeFallbackModels(result.models || []) : (result.models || []);
        sm.capabilitiesByVendor = sm.capabilitiesByVendor || {};
        sm.capabilitiesByVendor[defaultVendor] = result.capabilities || {};
      } catch (e) {
        if (e && e.name !== "AbortError" && !(e.message && e.message.indexOf("aborted") !== -1)) {
          send({ type: "error", text: "Failed to load " + defaultVendor + " SDK: " + (e.message || e) });
        }
      }
    }

    sm.modelsByVendor = sm.modelsByVendor || {};
    sm.installedVendors = detectInstalledVendors(linuxUser);
    sm.availableVendors = Object.keys(adapters);
    sm.providerRoutes = listProviderRoutes(sm.availableVendors, sm.installedVendors);

    send({
      type: "model_info",
      model: sm.currentModel || "",
      models: getModelsForVendor(defaultVendor),
      vendor: defaultVendor,
      availableVendors: sm.availableVendors,
      installedVendors: sm.installedVendors,
      providerRoutes: sm.providerRoutes,
    });
  }

  return {
    detectInstalledVendors: detectInstalledVendors,
    warmup: warmup,
  };
}

module.exports = { attachBridgeWarmup: attachBridgeWarmup };
