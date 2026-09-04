# Worktree Dev Port Ownership Debug Report

- **Symptom:** Every feature-worktree session reported the same external
  development server on `localhost:6075`, and Live UI could therefore target a
  server belonging to another branch.
- **Root cause:** Unmanaged development discovery treated a live configured
  base port as authoritative without checking the listener process working
  directory. Every worktree inherits the same `package.json` port, so every
  session claimed the one live process.
- **Fix:** Resolve listener PIDs and working directories with `lsof`, then mark
  an unmanaged server active only when its process runs inside the session's
  bound development directory. Foreign listeners remain stopped for that
  session, and dynamic allocation previews the next free port.
- **Evidence:** The live `6075` listener runs from
  `v2/.worktrees/2090-excel/webapp`. After the fix, that worktree reports
  external/running on `6075`; `v2/.worktrees/deps-batch/webapp` and the main
  checkout both report stopped with candidate port `6076`.
- **Regression test:** `test/project-workspace-dev-discovery.test.js` verifies
  both matching and foreign external listener ownership. Existing Live UI
  tests verify stopped session environments cannot pair.
- **Related:** Dynamic managed-server allocation was already per worktree. The
  bug was isolated to unmanaged process discovery.
- **Status:** DONE
