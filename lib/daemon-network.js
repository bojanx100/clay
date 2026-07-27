var fs = require("fs");
var path = require("path");
var os = require("os");
var execFile = require("child_process").execFile;

var TAILSCALE_SERVE_CACHE_MS = 5000;
var tailscaleServeCache = { at: 0, status: null, waiters: null };

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

function tailscaleServeUrlForPort(port, status) {
  if (!port || !status || !status.Web || !status.TCP) return null;
  var matches = [];
  var endpoints = Object.keys(status.Web);

  for (var i = 0; i < endpoints.length; i++) {
    var endpoint = endpoints[i];
    var splitAt = endpoint.lastIndexOf(":");
    if (splitAt <= 0) continue;
    var host = endpoint.slice(0, splitAt).replace(/\.$/, "");
    var externalPort = parseInt(endpoint.slice(splitAt + 1), 10);
    if (!/^[a-z0-9.-]+\.ts\.net$/i.test(host) || !externalPort) continue;
    var tcp = status.TCP[String(externalPort)];
    if (!tcp || !tcp.HTTPS) continue;
    var web = status.Web[endpoint];
    var handlers = web && web.Handlers ? Object.keys(web.Handlers) : [];
    for (var j = 0; j < handlers.length; j++) {
      var handler = web.Handlers[handlers[j]];
      if (!handler || !handler.Proxy) continue;
      try {
        var proxy = new URL(handler.Proxy);
        var proxyHost = proxy.hostname.toLowerCase();
        var proxyPort = parseInt(proxy.port, 10);
        if ((proxyHost === "localhost" || proxyHost === "127.0.0.1" ||
            proxyHost === "::1") && proxyPort === Number(port)) {
          matches.push({ host: host, port: externalPort });
        }
      } catch (e) {}
    }
  }

  if (!matches.length) return null;
  matches.sort(function (a, b) {
    if (a.port === Number(port) && b.port !== Number(port)) return -1;
    if (b.port === Number(port) && a.port !== Number(port)) return 1;
    if (a.port === 443 && b.port !== 443) return -1;
    if (b.port === 443 && a.port !== 443) return 1;
    return a.port - b.port;
  });
  var selected = matches[0];
  return "https://" + selected.host + (selected.port === 443 ? "" : ":" + selected.port) + "/";
}

function tailscaleCliPath() {
  if (process.env.TAILSCALE_CLI) return process.env.TAILSCALE_CLI;
  var macAppCli = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  if (process.platform === "darwin" && fs.existsSync(macAppCli)) return macAppCli;
  return "tailscale";
}

function readTailscaleServeStatus(callback) {
  var now = Date.now();
  if (tailscaleServeCache.at && now - tailscaleServeCache.at < TAILSCALE_SERVE_CACHE_MS) {
    callback(tailscaleServeCache.status);
    return;
  }
  if (tailscaleServeCache.waiters) {
    tailscaleServeCache.waiters.push(callback);
    return;
  }
  tailscaleServeCache.waiters = [callback];
  execFile(tailscaleCliPath(), ["serve", "status", "--json"], {
    timeout: 2000,
    maxBuffer: 256 * 1024,
  }, function (error, stdout) {
    var status = null;
    if (!error && stdout) {
      try { status = JSON.parse(stdout); } catch (e) {}
    }
    tailscaleServeCache.at = Date.now();
    tailscaleServeCache.status = status;
    var waiters = tailscaleServeCache.waiters || [];
    tailscaleServeCache.waiters = null;
    for (var i = 0; i < waiters.length; i++) waiters[i](status);
  });
}

function tailscaleUrlForPort(port, callback) {
  if (!port) {
    callback(null);
    return;
  }
  readTailscaleServeStatus(function (status) {
    callback(tailscaleServeUrlForPort(port, status));
  });
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
  tailscaleServeUrlForPort: tailscaleServeUrlForPort,
  tailscaleUrlForPort: tailscaleUrlForPort,
  toClayStudioHost: toClayStudioHost,
};
