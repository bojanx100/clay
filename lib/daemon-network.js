var fs = require("fs");
var path = require("path");
var os = require("os");

function loadTlsOptions(config, realHome, daemonDir) {
  if (!config.tls) return null;

  var builtinKeyPath = path.join(daemonDir, "certs", "privkey.pem");
  var builtinCertPath = path.join(daemonDir, "certs", "fullchain.pem");
  var certHome = process.env.CLAY_HOME || process.env.CLAUDE_RELAY_HOME || path.join(realHome, ".clay");
  var certDir = path.join(certHome, "certs");
  var userKeyPath = path.join(certDir, "key.pem");
  var userCertPath = path.join(certDir, "cert.pem");
  var fetched = null;
  try { fetched = require("./clay-studio-cert").cachedCertFiles(); } catch (e) {}

  var keyPath;
  var certPath;
  if (config.builtinCert !== false && fetched) {
    keyPath = fetched.key;
    certPath = fetched.cert;
    config.builtinCert = true;
  } else if (config.builtinCert !== false && fs.existsSync(builtinKeyPath) && fs.existsSync(builtinCertPath)) {
    keyPath = builtinKeyPath;
    certPath = builtinCertPath;
    config.builtinCert = true;
  } else {
    keyPath = userKeyPath;
    certPath = userCertPath;
  }

  try {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  } catch (e) {
    console.error("[daemon] TLS cert not found, falling back to HTTP");
    return null;
  }
}

function resolveLanIp() {
  var ifaces = os.networkInterfaces();
  var ifaceNames = Object.keys(ifaces);
  var i;
  var j;
  var addrs;

  for (i = 0; i < ifaceNames.length; i++) {
    addrs = ifaces[ifaceNames[i]];
    for (j = 0; j < addrs.length; j++) {
      if (addrs[j].family === "IPv4" && !addrs[j].internal && addrs[j].address.startsWith("100.")) {
        return addrs[j].address;
      }
    }
  }

  for (i = 0; i < ifaceNames.length; i++) {
    addrs = ifaces[ifaceNames[i]];
    for (j = 0; j < addrs.length; j++) {
      if (addrs[j].family === "IPv4" && !addrs[j].internal) {
        return addrs[j].address;
      }
    }
  }

  return null;
}

function toClayStudioHost(ip, port) {
  if (!ip) return null;
  return ip.replace(/\./g, "-") + ".d.clay.studio:" + port;
}

function shouldRefreshBuiltinCert(config) {
  return !!(config && config.tls && config.builtinCert);
}

function refreshBuiltinCertCache(config, timeoutMs, certModule) {
  if (!shouldRefreshBuiltinCert(config)) return Promise.resolve(false);

  var clayStudioCert = certModule || require("./clay-studio-cert");
  if (!clayStudioCert || typeof clayStudioCert.refreshCache !== "function") {
    return Promise.resolve(false);
  }

  return clayStudioCert.refreshCache(timeoutMs || 5000).then(function (ok) {
    return !!ok;
  }).catch(function () {
    return false;
  });
}

module.exports = {
  loadTlsOptions: loadTlsOptions,
  refreshBuiltinCertCache: refreshBuiltinCertCache,
  resolveLanIp: resolveLanIp,
  shouldRefreshBuiltinCert: shouldRefreshBuiltinCert,
  toClayStudioHost: toClayStudioHost,
};
