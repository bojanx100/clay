var crypto = require("crypto");

function createBrowserExtensionState() {
  return {
    _browserTabList: {},
    _extensionWs: null,
    _extensionId: null,
    pendingExtensionRequests: {},
  };
}

function disconnectBrowserExtension(browserState, ws, source, reason) {
  if (browserState._extensionWs !== ws) return false;
  var safeSource = String(source || "unknown").replace(/\s+/g, "_").slice(0, 40);
  var safeReason = String(reason || "unknown").replace(/\s+/g, " ").trim().slice(0, 160);
  console.log("[browser-extension] state=disconnected source=" + safeSource +
    " reason=" + safeReason);
  browserState._extensionWs = null;
  browserState._extensionId = null;
  var tabs = browserState._browserTabList || {};
  Object.keys(tabs).forEach(function (tabId) { delete tabs[tabId]; });
  var pending = browserState.pendingExtensionRequests || {};
  Object.keys(pending).forEach(function (requestId) {
    var request = pending[requestId];
    if (request.timer) clearTimeout(request.timer);
    delete pending[requestId];
    if (request.reject) {
      request.reject(new Error("Browser extension disconnected: " + safeReason));
    }
  });
  return true;
}

function attachProjectBrowserExtension(ctx) {
  var sendTo = ctx.sendTo;
  var extToken = crypto.randomUUID();
  var browserState = ctx.browserState || createBrowserExtensionState();

  function sendExtensionCommand(ws, command, args, timeout) {
    return new Promise(function (resolve, reject) {
      var requestId = crypto.randomUUID();
      var ms = timeout || 3000;
      var timer = setTimeout(function () {
        delete browserState.pendingExtensionRequests[requestId];
        console.warn("[browser-extension] command=" + command +
          " state=timeout timeoutMs=" + ms);
        reject(new Error("Browser extension command timed out: " + command));
      }, ms);
      browserState.pendingExtensionRequests[requestId] = {
        resolve: resolve,
        reject: reject,
        timer: timer,
      };
      sendTo(ws, {
        type: "extension_command",
        command: command,
        args: args,
        requestId: requestId,
      });
    });
  }

  function sendExtensionCommandAny(command, args, timeout) {
    if (!browserState._extensionWs || browserState._extensionWs.readyState !== 1) {
      console.warn("[browser-extension] command=" + command + " state=disconnected");
      return Promise.reject(new Error("Browser extension not connected"));
    }
    return sendExtensionCommand(browserState._extensionWs, command, args, timeout);
  }

  function requestTabContext(tabId) {
    if (!browserState._extensionWs || browserState._extensionWs.readyState !== 1) {
      return Promise.resolve(null);
    }
    var extWs = browserState._extensionWs;
    return sendExtensionCommand(extWs, "tab_inject", { tabId: tabId }).then(function () {}, function () {}).then(function () {
      return Promise.all([
        sendExtensionCommand(extWs, "tab_console", { tabId: tabId }),
        sendExtensionCommand(extWs, "tab_network", { tabId: tabId }),
        sendExtensionCommand(extWs, "tab_page_text", { tabId: tabId }),
        sendExtensionCommand(extWs, "tab_screenshot", { tabId: tabId }),
      ]);
    }).then(function (results) {
      return {
        console: results[0],
        network: results[1],
        pageText: results[2],
        screenshot: results[3],
      };
    }).catch(function () {
      return null;
    });
  }

  return {
    extToken: extToken,
    browserState: browserState,
    sendExtensionCommandAny: sendExtensionCommandAny,
    requestTabContext: requestTabContext,
  };
}

module.exports = {
  attachProjectBrowserExtension: attachProjectBrowserExtension,
  createBrowserExtensionState: createBrowserExtensionState,
  disconnectBrowserExtension: disconnectBrowserExtension,
};
