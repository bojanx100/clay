var scriptPromises = {};
var stylesheetPromises = {};

function loadScript(url) {
  if (scriptPromises[url]) return scriptPromises[url];
  scriptPromises[url] = new Promise(function (resolve, reject) {
    var script = document.createElement("script");
    script.src = url;
    script.onload = function () { resolve(); };
    script.onerror = function () {
      delete scriptPromises[url];
      reject(new Error("Failed to load " + url));
    };
    document.head.appendChild(script);
  });
  return scriptPromises[url];
}

function loadStylesheet(url) {
  if (stylesheetPromises[url]) return stylesheetPromises[url];
  stylesheetPromises[url] = new Promise(function (resolve, reject) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.onload = function () { resolve(); };
    link.onerror = function () {
      delete stylesheetPromises[url];
      reject(new Error("Failed to load " + url));
    };
    document.head.appendChild(link);
  });
  return stylesheetPromises[url];
}

var mermaidPromise = null;
export function ensureMermaidAsset() {
  if (typeof mermaid !== "undefined") return Promise.resolve(mermaid);
  if (!mermaidPromise) {
    mermaidPromise = loadScript("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js")
      .then(function () { return mermaid; })
      .catch(function (err) {
        mermaidPromise = null;
        throw err;
      });
  }
  return mermaidPromise;
}

var terminalPromise = null;
export function ensureTerminalAssets() {
  if (typeof Terminal !== "undefined" &&
      typeof FitAddon !== "undefined" &&
      typeof WebLinksAddon !== "undefined" &&
      typeof WebglAddon !== "undefined") {
    return Promise.resolve();
  }
  if (!terminalPromise) {
    var cssPromise = loadStylesheet("https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css");
    var scriptsPromise = loadScript("https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js")
      .then(function () {
        return loadScript("https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js");
      })
      .then(function () {
        return loadScript("https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0/lib/addon-web-links.min.js");
      })
      .then(function () {
        return loadScript("https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0/lib/addon-webgl.min.js");
      });
    terminalPromise = Promise.all([cssPromise, scriptsPromise])
      .then(function () {})
      .catch(function (err) {
        terminalPromise = null;
        throw err;
      });
  }
  return terminalPromise;
}
