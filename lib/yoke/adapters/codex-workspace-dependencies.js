var fs = require("fs");
var os = require("os");
var path = require("path");

var FEATURE_NAME = "workspace_dependencies";
var TOOL_NAME = "load_workspace_dependencies";
var TOOL_DESCRIPTION = "Locate the configured bundled workspace dependency runtime paths for this local Clay Codex thread, including Node.js, Python, and useful libraries for working with spreadsheets, slide decks, Word documents, and PDFs. This is read-only and takes no arguments.";
var TOOL_DEFINITION = {
  type: "function",
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
var DEVELOPER_INSTRUCTIONS = "### Workspace Dependencies\n- For sheets, slides, documents, and PDFs, call `load_workspace_dependencies` to locate Clay's validated bundled runtime and libraries before running artifact builders.";

function cloneToolDefinition() {
  return {
    type: TOOL_DEFINITION.type,
    name: TOOL_DEFINITION.name,
    description: TOOL_DEFINITION.description,
    inputSchema: {
      type: TOOL_DEFINITION.inputSchema.type,
      properties: {},
      additionalProperties: false,
    },
  };
}

function failureResponse(message) {
  return {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
}

function isEmptyArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === 0;
}

function appendDeveloperInstructions(prompt) {
  var current = typeof prompt === "string" ? prompt.trimEnd() : "";
  return current ? current + "\n\n" + DEVELOPER_INSTRUCTIONS : DEVELOPER_INSTRUCTIONS;
}

function createDisabledSupport(reason, options) {
  var canConfigureDynamicTools = !options || options.canConfigureDynamicTools !== false;
  return {
    enabled: false,
    reason: reason || "Workspace dependency runtime unavailable.",
    canConfigureDynamicTools: canConfigureDynamicTools,
    dynamicTools: [],
    appendInstructions: function(prompt) { return prompt || ""; },
    handleCall: function() {
      return Promise.resolve(failureResponse(reason || "Workspace dependency runtime unavailable."));
    },
  };
}

function defaultRuntimeRoot(homeDir) {
  return path.join(homeDir || os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime");
}

function isInsideRoot(root, candidate) {
  var resolvedRoot = path.resolve(root);
  var resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.indexOf(resolvedRoot + path.sep) === 0;
}

function realPathIsInsideRoot(root, candidate) {
  try {
    return isInsideRoot(fs.realpathSync(root), fs.realpathSync(candidate));
  } catch (e) {
    return false;
  }
}

function requiredFile(runtimeRoot, candidate, label) {
  if (!isInsideRoot(runtimeRoot, candidate)) return label + " resolves outside the runtime root.";
  try {
    if (!fs.statSync(candidate).isFile()) return label + " is not a file.";
    if (!realPathIsInsideRoot(runtimeRoot, candidate)) return label + " resolves outside the runtime root.";
    if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return null;
  } catch (e) {
    return label + " is unavailable.";
  }
}

function requiredDirectory(runtimeRoot, candidate, label) {
  if (!isInsideRoot(runtimeRoot, candidate)) return label + " resolves outside the runtime root.";
  try {
    if (!fs.statSync(candidate).isDirectory()) return label + " is not a directory.";
    return realPathIsInsideRoot(runtimeRoot, candidate) ? null : label + " resolves outside the runtime root.";
  } catch (e) {
    return label + " is unavailable.";
  }
}

function optionalExecutable(runtimeRoot, candidate) {
  return requiredFile(runtimeRoot, candidate, "Optional executable") === null ? candidate : null;
}

function readRuntimeMetadata(runtimeRoot) {
  var metadataPath = path.join(runtimeRoot, "runtime.json");
  if (!isInsideRoot(runtimeRoot, metadataPath)) {
    return { ok: false, reason: "Runtime metadata resolves outside the runtime root." };
  }
  try {
    if (!realPathIsInsideRoot(runtimeRoot, metadataPath)) {
      return { ok: false, reason: "Runtime metadata resolves outside the runtime root." };
    }
    var parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "Runtime metadata is malformed." };
    }
    return { ok: true, metadata: parsed };
  } catch (e) {
    return { ok: false, reason: "Runtime metadata is missing or unreadable." };
  }
}

function inspectRuntime(options) {
  var runtimeRoot = path.resolve(options.runtimeRoot);
  var platform = options.platform || process.platform;
  var arch = options.arch || process.arch;
  var metadataResult = readRuntimeMetadata(runtimeRoot);
  if (!metadataResult.ok) return metadataResult;

  var metadata = metadataResult.metadata;
  if (metadata.bundleFormatVersion !== 2) {
    return { ok: false, reason: "Unsupported workspace dependency bundle format." };
  }
  if (metadata.targetPlatform !== platform) {
    return { ok: false, reason: "Workspace dependency runtime platform does not match this host." };
  }
  if (metadata.targetArch !== arch) {
    return { ok: false, reason: "Workspace dependency runtime architecture does not match this host." };
  }
  if (typeof metadata.bundleVersion !== "string" || !metadata.bundleVersion) {
    return { ok: false, reason: "Workspace dependency bundle version is missing." };
  }
  var pythonMatch = typeof metadata.pythonVersion === "string"
    ? metadata.pythonVersion.match(/^(\d+)\.(\d+)/)
    : null;
  if (!pythonMatch) {
    return { ok: false, reason: "Workspace dependency Python version is invalid." };
  }

  var dependenciesRoot = path.join(runtimeRoot, "dependencies");
  var nodePath = platform === "win32"
    ? path.join(dependenciesRoot, "node", "node.exe")
    : path.join(dependenciesRoot, "node", "bin", "node");
  var nodeModulesPath = path.join(dependenciesRoot, "node", "node_modules");
  var artifactToolPath = path.join(nodeModulesPath, "@oai", "artifact-tool");
  var pythonPath = platform === "win32"
    ? path.join(dependenciesRoot, "python", "python.exe")
    : path.join(dependenciesRoot, "python", "bin", "python");
  var pythonLibrariesPath = platform === "win32"
    ? path.join(dependenciesRoot, "python", "Lib", "site-packages")
    : path.join(dependenciesRoot, "python", "lib", "python" + pythonMatch[1] + "." + pythonMatch[2], "site-packages");
  var overrideBinPath = path.join(dependenciesRoot, "bin", "override");
  var fallbackBinPath = path.join(dependenciesRoot, "bin", "fallback");
  var requiredPaths = [
    requiredFile(runtimeRoot, nodePath, "Bundled Node.js executable"),
    requiredDirectory(runtimeRoot, nodeModulesPath, "Bundled Node.js packages"),
    requiredDirectory(runtimeRoot, artifactToolPath, "Bundled @oai/artifact-tool package"),
    requiredFile(runtimeRoot, pythonPath, "Bundled Python executable"),
    requiredDirectory(runtimeRoot, pythonLibrariesPath, "Bundled Python packages"),
    requiredDirectory(runtimeRoot, overrideBinPath, "Bundled override binaries"),
    requiredDirectory(runtimeRoot, fallbackBinPath, "Bundled fallback binaries"),
  ];
  var problem = requiredPaths.find(function(item) { return item !== null; });
  if (problem) return { ok: false, reason: problem };

  var executableSuffix = platform === "win32" ? ".exe" : "";
  var details = {
    artifactToolVersion: typeof metadata.artifactToolVersion === "string" ? metadata.artifactToolVersion : null,
    bundleVersion: metadata.bundleVersion,
    fallbackBinPath: fallbackBinPath,
    gitPath: optionalExecutable(runtimeRoot, path.join(fallbackBinPath, "git" + executableSuffix)),
    nodeModulesPath: nodeModulesPath,
    nodePath: nodePath,
    overrideBinPath: overrideBinPath,
    pnpmPath: optionalExecutable(runtimeRoot, path.join(fallbackBinPath, platform === "win32" ? "pnpm.cmd" : "pnpm")),
    pythonLibrariesPath: pythonLibrariesPath,
    pythonPath: pythonPath,
  };
  return { ok: true, details: details };
}

function inlineCode(value) {
  return "`" + String(value).replace(/`/g, "\\`") + "`";
}

function formatRuntimeInstructions(details) {
  var lines = [
    "### Workspace Dependencies",
    "- Bundle version: " + inlineCode(details.bundleVersion),
  ];
  if (details.artifactToolVersion) {
    lines.push("- Artifact tool version: " + inlineCode(details.artifactToolVersion));
  }
  if (details.gitPath) lines.push("- Git executable: " + inlineCode(details.gitPath));
  lines.push("- Node.js executable: " + inlineCode(details.nodePath));
  lines.push("- Node.js packages: " + inlineCode(details.nodeModulesPath));
  if (details.pnpmPath) lines.push("- pnpm executable: " + inlineCode(details.pnpmPath));
  lines.push("- Python executable: " + inlineCode(details.pythonPath));
  lines.push("- Python packages: " + inlineCode(details.pythonLibrariesPath));
  lines.push("- Override binaries: " + inlineCode(details.overrideBinPath));
  lines.push("- Fallback binaries: " + inlineCode(details.fallbackBinPath));
  return lines.join("\n");
}

async function featureEnabled(appServer) {
  var cursor = null;
  var pages = 0;
  do {
    var params = { limit: 100 };
    if (cursor) params.cursor = cursor;
    var result = await appServer.send("experimentalFeature/list", params, 10000);
    var data = result && Array.isArray(result.data) ? result.data : [];
    for (var i = 0; i < data.length; i++) {
      if (data[i] && data[i].name === FEATURE_NAME) return data[i].enabled === true;
    }
    cursor = result && result.nextCursor ? result.nextCursor : null;
    pages++;
  } while (cursor && pages < 20);
  return false;
}

async function createWorkspaceDependenciesSupport(options) {
  var enabled;
  try {
    enabled = await featureEnabled(options.appServer);
  } catch (e) {
    return createDisabledSupport("Workspace dependency feature discovery is unavailable.", {
      canConfigureDynamicTools: false,
    });
  }
  if (!enabled) return createDisabledSupport("Workspace dependency tools are disabled in Codex settings.");

  var runtimeRoot = options.runtimeRoot || defaultRuntimeRoot(options.homeDir);
  var runtimeResult = inspectRuntime({
    runtimeRoot: runtimeRoot,
    platform: options.platform,
    arch: options.arch,
  });
  if (!runtimeResult.ok) return createDisabledSupport(runtimeResult.reason);

  return {
    enabled: true,
    reason: null,
    canConfigureDynamicTools: true,
    runtimeRoot: runtimeRoot,
    details: runtimeResult.details,
    dynamicTools: [cloneToolDefinition()],
    appendInstructions: appendDeveloperInstructions,
    handleCall: async function(argumentsValue) {
      if (!isEmptyArguments(argumentsValue)) {
        return failureResponse(TOOL_NAME + " takes no arguments.");
      }
      var latestRuntime = inspectRuntime({
        runtimeRoot: runtimeRoot,
        platform: options.platform,
        arch: options.arch,
      });
      if (!latestRuntime.ok) return failureResponse(latestRuntime.reason);
      return {
        contentItems: [{
          type: "inputText",
          text: "Workspace dependencies are available for this local Clay Codex thread.\n\n" + formatRuntimeInstructions(latestRuntime.details),
        }],
        success: true,
      };
    },
  };
}

module.exports = {
  FEATURE_NAME: FEATURE_NAME,
  TOOL_NAME: TOOL_NAME,
  createDisabledSupport: createDisabledSupport,
  createWorkspaceDependenciesSupport: createWorkspaceDependenciesSupport,
  defaultRuntimeRoot: defaultRuntimeRoot,
  inspectRuntime: inspectRuntime,
};
