// Static, init-free facts about each vendor YOKE supports. Host code that
// needs metadata before adapter initialization should read it from here.
// Do not import adapters into this module.

var VENDOR_REGISTRY = {
  claude: {
    displayName: "Claude Code",
    loginCommand: "claude login",
    binaryName: "claude",
    avatar: "/claude-code-avatar.png",
    homepage: "https://claude.com/product/claude-code",
    sessionModes: ["gui", "tui"],
    osUserIsolation: true,
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
    osUserIsolation: true,
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
    osUserIsolation: false,
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

module.exports = {
  VENDOR_REGISTRY: VENDOR_REGISTRY,
  getVendorInfo: getVendorInfo,
  supportsSessionMode: supportsSessionMode,
};
