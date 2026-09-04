function attachProjectSessionsGitAccounts(ctx) {
  var opts = ctx.opts;
  var sendTo = ctx.sendTo;

  function handleGitAccountMessage(ws, msg) {
    if (msg.type === "list_git_accounts") {
      if (typeof opts.onListGitAccounts === "function") {
        // The callback may return a promise (gh auth status is network-bound).
        Promise.resolve(opts.onListGitAccounts()).then(function (gaList) {
          sendTo(ws, { type: "git_accounts_list", ok: gaList.ok, accounts: gaList.accounts || [] });
        }).catch(function () {
          sendTo(ws, { type: "git_accounts_list", ok: false, accounts: [] });
        });
      } else {
        sendTo(ws, { type: "git_accounts_list", ok: false, accounts: [] });
      }
      return true;
    }

    if (msg.type === "get_project_git_account") {
      if (!msg.slug) {
        sendTo(ws, { type: "project_git_account", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onGetProjectGitAccount === "function") {
        var gaGet = opts.onGetProjectGitAccount(msg.slug);
        sendTo(ws, { type: "project_git_account", ok: gaGet.ok, slug: msg.slug, account: gaGet.account || null, resolved: gaGet.resolved || null, isRepo: gaGet.isRepo, error: gaGet.error });
      } else {
        sendTo(ws, { type: "project_git_account", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "set_project_git_account") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_git_account_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectGitAccount === "function") {
        var gaSet = opts.onSetProjectGitAccount(msg.slug, msg.account || null);
        sendTo(ws, { type: "set_project_git_account_result", ok: gaSet.ok, slug: msg.slug, account: gaSet.account || null, error: gaSet.error });
      } else {
        sendTo(ws, { type: "set_project_git_account_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    return false;
  }

  return {
    handleGitAccountMessage: handleGitAccountMessage,
  };
}

module.exports = { attachProjectSessionsGitAccounts: attachProjectSessionsGitAccounts };
