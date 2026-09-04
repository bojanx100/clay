// Static, init-free facts about each vendor YOKE supports. Host code that
// needs metadata before adapter initialization should read it from here.
// Do not import adapters into this module.

var EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

var VENDOR_REGISTRY = {
  claude: {
    displayName: "Claude Code",
    loginCommand: "claude login",
    loginHint: "Choose an Anthropic subscription, Console account, Bedrock, or Vertex flow.",
    installCommands: {
      darwin: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      win32: "npm install -g @anthropic-ai/claude-code",
    },
    binaryName: "claude",
    avatar: "/claude-code-avatar.png",
    homepage: "https://claude.com/product/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    description: "Anthropic's coding agent, using a Claude subscription or configured cloud credentials.",
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
    loginHint: "Complete the device flow with the ChatGPT or OpenAI account Clay should use.",
    installCommands: {
      darwin: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      win32: "npm install -g @openai/codex",
    },
    binaryName: "codex",
    avatar: "/codex-avatar.png",
    homepage: "https://openai.com/codex/",
    docsUrl: "https://developers.openai.com/codex/cli/",
    description: "OpenAI's coding agent, using the locally authenticated Codex account.",
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
    loginHint: "Complete GitHub's device flow. Organization policy must allow Copilot CLI.",
    installCommands: {
      darwin: "npm install -g @github/copilot",
      linux: "npm install -g @github/copilot",
      win32: "npm install -g @github/copilot",
    },
    binaryName: "copilot",
    avatar: "/github-copilot-avatar.svg",
    homepage: "https://github.com/features/copilot/cli",
    docsUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    description: "GitHub's CLI route for Copilot-hosted Claude and GPT models.",
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
    loginHint: "The first launch opens Google sign-in or accepts a configured Gemini API key.",
    installCommands: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      win32: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    binaryName: "agy",
    avatar: "/antigravity-avatar.svg",
    homepage: "https://antigravity.google/",
    docsUrl: "https://antigravity.google/docs/cli/install/",
    description: "Google's agent CLI, using account sign-in or explicitly configured Gemini credentials.",
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
    loginHint: "Choose one or more model providers. OpenCode is ready only after it exposes a usable model.",
    installCommands: {
      darwin: "curl -fsSL https://opencode.ai/install | bash",
      linux: "curl -fsSL https://opencode.ai/install | bash",
      win32: "npm install -g opencode-ai",
    },
    binaryName: "opencode",
    avatar: "/opencode-avatar.svg",
    homepage: "https://opencode.ai/",
    docsUrl: "https://opencode.ai/docs/providers/",
    description: "A multi-provider agent. Its actual models and costs depend on the providers configured inside OpenCode.",
    sessionModes: ["gui"],
    effortLevels: [],
    osUserIsolation: false,
    sessionBoundTools: true,
    usageDashboard: null,
    rateLimitTracking: false,
  },
  kimi: {
    displayName: "Kimi Code",
    loginCommand: "kimi",
    loginHint: "Type /login in Kimi, then choose Kimi OAuth or another configured API source.",
    installCommands: {
      darwin: "curl -LsSf https://code.kimi.com/install.sh | bash",
      linux: "curl -LsSf https://code.kimi.com/install.sh | bash",
      win32: "Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression",
    },
    binaryName: "kimi",
    avatar: "/kimi-avatar.svg",
    homepage: "https://www.kimi.com/",
    docsUrl: "https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/guides/getting-started.md",
    description: "Moonshot AI's coding agent, using Kimi OAuth or another API source selected in its CLI.",
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
    loginHint: "Complete xAI's device flow with an account that has Grok Build access.",
    installCommands: {
      darwin: "curl -fsSL https://x.ai/cli/install.sh | bash",
      linux: "curl -fsSL https://x.ai/cli/install.sh | bash",
    },
    binaryName: "grok",
    avatar: "/grok-avatar.svg",
    homepage: "https://grok.com/",
    docsUrl: "https://docs.x.ai/build/cli/reference",
    description: "xAI's coding agent and ACP runtime. Access depends on the authenticated xAI plan.",
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
    loginHint: "Type /auth in Qwen, then configure Qwen OAuth, an API provider, or a local model.",
    installCommands: {
      darwin: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      linux: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash",
      win32: "irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex",
    },
    binaryName: "qwen",
    avatar: "/qwen-avatar.svg",
    homepage: "https://qwen.ai/",
    docsUrl: "https://github.com/QwenLM/qwen-code",
    description: "An open-source multi-provider agent supporting Qwen, hosted APIs, and local model runtimes.",
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
    loginHint: "Choose JetBrains account, Junie API key, BYOK, or a supported local/custom model.",
    installCommands: {
      darwin: "curl -fsSL https://junie.jetbrains.com/install.sh | bash",
      linux: "curl -fsSL https://junie.jetbrains.com/install.sh | bash",
      win32: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"iex (irm 'https://junie.jetbrains.com/install.ps1')\"",
    },
    binaryName: "junie",
    avatar: "/junie-avatar.svg",
    homepage: "https://www.jetbrains.com/junie/",
    docsUrl: "https://junie.jetbrains.com/docs/junie-cli.html",
    description: "JetBrains' coding agent, supporting subscriptions, usage-based keys, BYOK, and local models.",
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
    loginHint: "Choose Builder ID, Google, GitHub, or organization identity in Kiro's browser/device flow.",
    installCommands: {
      darwin: "curl -fsSL https://cli.kiro.dev/install | bash",
      linux: "curl -fsSL https://cli.kiro.dev/install | bash",
    },
    binaryName: "kiro-cli",
    avatar: "/kiro-avatar.svg",
    homepage: "https://kiro.dev/",
    docsUrl: "https://kiro.dev/docs/cli/installation/",
    description: "Kiro's agent CLI, using free social/Builder ID or organization authentication.",
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
