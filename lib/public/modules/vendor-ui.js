// Vendor presentation metadata is hydrated from the server's YOKE registry.
// Claude is the only bootstrap fallback needed before the initial info frame.
export var VENDOR_AVATARS = { claude: "/claude-code-avatar.png" };
export var VENDOR_NAMES = { claude: "Claude Code" };
export var VENDOR_ORDER = ["claude"];
export var VENDOR_HOMEPAGES = { claude: "https://claude.com/product/claude-code" };

function replaceMap(target, next) {
  var oldKeys = Object.keys(target);
  for (var i = 0; i < oldKeys.length; i++) delete target[oldKeys[i]];
  var nextKeys = Object.keys(next);
  for (var j = 0; j < nextKeys.length; j++) target[nextKeys[j]] = next[nextKeys[j]];
}

export function applyVendorRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return;
  var avatars = {};
  var names = {};
  var homepages = {};
  var order = Object.keys(registry);
  for (var i = 0; i < order.length; i++) {
    var vendor = order[i];
    var info = registry[vendor] || {};
    names[vendor] = info.displayName || vendor;
    avatars[vendor] = info.avatar || VENDOR_AVATARS.claude;
    homepages[vendor] = info.homepage || "";
  }
  replaceMap(VENDOR_AVATARS, avatars);
  replaceMap(VENDOR_NAMES, names);
  replaceMap(VENDOR_HOMEPAGES, homepages);
  VENDOR_ORDER.splice(0, VENDOR_ORDER.length);
  for (var j = 0; j < order.length; j++) VENDOR_ORDER.push(order[j]);
}
