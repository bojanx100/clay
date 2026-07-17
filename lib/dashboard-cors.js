// dashboard-cors.js - CORS origin validation for the local task dashboard.

function isDashboardOriginAllowed(req, origin) {
  if (origin === "http://127.0.0.1:8765" || origin === "http://localhost:8765") return true;
  if (!origin) return false;
  try {
    var url = new URL(origin);
    var host = String(req.headers.host || "").split(":")[0];
    return url.protocol === "http:" && url.port === "8765" && !!host && url.hostname === host;
  } catch (e) {
    return false;
  }
}

module.exports = { isDashboardOriginAllowed: isDashboardOriginAllowed };
