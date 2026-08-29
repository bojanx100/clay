var profiles = require("./acp-agent-profiles");

var ADDITIONAL_VENDOR_IDS = [
  "antigravity",
  "opencode",
  "kimi",
  "grok",
  "qwen",
  "junie",
  "kiro",
];

var GENERIC_ACP_FACTORIES = {
  opencode: "createOpenCodeAdapter",
  kimi: "createKimiAdapter",
  grok: "createGrokAdapter",
  qwen: "createQwenAdapter",
  junie: "createJunieAdapter",
};

function emptyVendorMap() {
  var result = {};
  for (var i = 0; i < ADDITIONAL_VENDOR_IDS.length; i++) {
    result[ADDITIONAL_VENDOR_IDS[i]] = false;
  }
  return result;
}

function createGenericAdapter(vendor, opts) {
  var modulePath = "./adapters/" + vendor;
  var factoryName = GENERIC_ACP_FACTORIES[vendor];
  if (!factoryName) return null;
  return require(modulePath)[factoryName](opts);
}

function createAdditionalAdapter(vendor, opts) {
  var generic = createGenericAdapter(vendor, opts);
  if (generic) return generic;
  if (vendor === "antigravity") {
    return require("./adapters/antigravity").createAntigravityAdapter(opts);
  }
  if (vendor === "kiro") {
    return require("./adapters/kiro").createKiroAdapter(opts);
  }
  return null;
}

function findAdditionalBinary(vendor) {
  var profile = profiles.getAcpAgentProfile(vendor);
  if (profile) return profiles.findAcpAgentPath(profile);
  if (vendor === "antigravity") {
    return require("./adapters/antigravity").findAntigravityPath();
  }
  if (vendor === "kiro") {
    return require("./adapters/kiro").findKiroPath();
  }
  return null;
}

function checkAdditionalInstalled() {
  var result = emptyVendorMap();
  for (var i = 0; i < ADDITIONAL_VENDOR_IDS.length; i++) {
    var vendor = ADDITIONAL_VENDOR_IDS[i];
    try {
      result[vendor] = !!findAdditionalBinary(vendor);
    } catch (e) {
      result[vendor] = false;
    }
  }
  return result;
}

function appendAdditionalAuth(auth, installed, osUsers) {
  for (var i = 0; i < ADDITIONAL_VENDOR_IDS.length; i++) {
    var vendor = ADDITIONAL_VENDOR_IDS[i];
    auth[vendor] = !osUsers && !!installed[vendor];
  }
  return auth;
}

function createInstalledAdditionalAdapters(adapters, auth, installed, opts, supportsIsolation) {
  for (var i = 0; i < ADDITIONAL_VENDOR_IDS.length; i++) {
    var vendor = ADDITIONAL_VENDOR_IDS[i];
    if (!installed[vendor] || !supportsIsolation(vendor)) continue;
    try {
      adapters[vendor] = createAdditionalAdapter(vendor, {
        cwd: opts.cwd,
        slug: opts.slug,
      });
      if (adapters[vendor]) {
        auth[vendor] = true;
        console.log("[yoke] Adapter created: " + vendor);
      }
    } catch (e) {
      console.error("[yoke] Failed to create adapter for " + vendor + ":", e.message);
    }
  }
}

module.exports = {
  ADDITIONAL_VENDOR_IDS: ADDITIONAL_VENDOR_IDS,
  appendAdditionalAuth: appendAdditionalAuth,
  checkAdditionalInstalled: checkAdditionalInstalled,
  createAdditionalAdapter: createAdditionalAdapter,
  createInstalledAdditionalAdapters: createInstalledAdditionalAdapters,
  emptyVendorMap: emptyVendorMap,
};
