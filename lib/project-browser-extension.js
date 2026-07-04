var crypto = require("crypto");

function attachProjectBrowserExtension(ctx) {
  var sendTo = ctx.sendTo;
  var extToken = crypto.randomUUID();
  var browserState = {
    _browserTabList: {},
    _extensionWs: null,
    pendingExtensionRequests: {},
  };

  function sendExtensionCommand(ws, command, args, timeout) {
    return new Promise(function (resolve) {
      var requestId = crypto.randomUUID();
      var ms = timeout || 3000;
      var timer = setTimeout(function () {
        delete browserState.pendingExtensionRequests[requestId];
        resolve(null);
      }, ms);
      browserState.pendingExtensionRequests[requestId] = { resolve: resolve, timer: timer };
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
};
