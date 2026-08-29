// Static, init-free facts about each vendor YOKE supports. Host code that
// needs metadata before adapter initialization should read it from here.
// Do not import adapters into this module.

var EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

var VENDOR_REGISTRY = {
  claude: {
    displayName: "Claude Code",
    loginCommand: "claude login",
    binaryName: "claude",
    avatar: "/claude-code-avatar.png",
    homepage: "https://claude.com/product/claude-code",
    sessionModes: ["gui", "tui"],
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    osUserIsolation: true,
    sessionBoundTools: true,
    usageDashboard: {
      icon: "/claude-code-avatar.png",
      alt: "Claude Code",
      href: "https://claude.ai/settings/usage",
      title: "Check usage on claude.ai",
    },
    rateLimitTracking: true,
  },
  codex: {
    displayName: "Codex",
    loginCommand: "codex login --device-auth",
    binaryName: "codex",
    avatar: "/codex-avatar.png",
    homepage: "https://openai.com/codex/",
    sessionModes: ["gui"],
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    osUserIsolation: true,
    sessionBoundTools: false,
    usageDashboard: {
      icon: "/codex-avatar.png",
      alt: "Codex",
      href: "https://chatgpt.com/codex/settings/usage",
      title: "Check Codex usage on ChatGPT",
    },
    rateLimitTracking: true,
  },
  "github-copilot": {
    displayName: "GitHub Copilot",
    loginCommand: "copilot login",
    binaryName: "copilot",
    avatar: "/github-copilot-avatar.svg",
    homepage: "https://github.com/features/copilot/cli",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: false,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  antigravity: {
    displayName: "Antigravity CLI",
    loginCommand: "agy",
    binaryName: "agy",
    avatar: "/antigravity-avatar.svg",
    homepage: "https://antigravity.google/",
    sessionModes: ["gui"],
    effortLevels: ["low", "medium", "high"],
    osUserIsolation: false,
    sessionBoundTools: false,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  opencode: {
    displayName: "OpenCode",
    loginCommand: "opencode auth login",
    binaryName: "opencode",
    avatar: "/opencode-avatar.svg",
    homepage: "https://opencode.ai/",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: true,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  kimi: {
    displayName: "Kimi Code",
    loginCommand: "kimi login",
    binaryName: "kimi",
    avatar: "/kimi-avatar.svg",
    homepage: "https://www.kimi.com/",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: true,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  grok: {
    displayName: "Grok Build",
    loginCommand: "grok login --device-auth",
    binaryName: "grok",
    avatar: "/grok-avatar.svg",
    homepage: "https://grok.com/",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: true,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  qwen: {
    displayName: "Qwen Code",
    loginCommand: "qwen",
    binaryName: "qwen",
    avatar: "/qwen-avatar.svg",
    homepage: "https://qwen.ai/",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: true,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  junie: {
    displayName: "Junie CLI",
    loginCommand: "junie",
    binaryName: "junie",
    avatar: "/junie-avatar.svg",
    homepage: "https://www.jetbrains.com/junie/",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: true,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  kiro: {
    displayName: "Kiro CLI",
    loginCommand: "kiro-cli login",
    binaryName: "kiro-cli",
    avatar: "/kiro-avatar.svg",
    homepage: "https://kiro.dev/",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: true,
    usageDashboard: null,
    rateLimitTracking: false,
  },
};

function getVendorInfo(vendor) {
  return VENDOR_REGISTRY[vendor] || null;
}

function supportsSessionMode(vendor, mode) {
  var info = getVendorInfo(vendor);
  return !!(info && info.sessionModes.indexOf(mode) !== -1);
}

function clampEffort(vendor, effort) {
  if (!effort) return undefined;
  var info = VENDOR_REGISTRY[vendor];
  var levels = (info && info.effortLevels) || [];
  if (levels.length === 0) return undefined;
  if (levels.indexOf(effort) !== -1) return effort;
  var position = EFFORT_ORDER.indexOf(effort);
  if (position === -1) return undefined;
  var nearest = levels[0];
  var nearestDistance = Infinity;
  for (var i = 0; i < levels.length; i++) {
    var distance = Math.abs(EFFORT_ORDER.indexOf(levels[i]) - position);
    if (distance < nearestDistance) {
      nearest = levels[i];
      nearestDistance = distance;
    }
  }
  return nearest;
}

module.exports = {
  VENDOR_REGISTRY: VENDOR_REGISTRY,
  getVendorInfo: getVendorInfo,
  supportsSessionMode: supportsSessionMode,
  clampEffort: clampEffort,
};
