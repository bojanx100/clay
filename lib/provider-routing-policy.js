var ROUTING_PROFILES = ["free-endurance", "balanced", "best-available"];

function normalizeRoutingProfile(value) {
  return ROUTING_PROFILES.indexOf(value) !== -1 ? value : "balanced";
}

module.exports = {
  ROUTING_PROFILES: ROUTING_PROFILES,
  normalizeRoutingProfile: normalizeRoutingProfile,
};
