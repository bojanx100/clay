# DEBUG REPORT

- **Symptom:** The Codex usage chip opened `https://chatgpt.com/admin/usage`, which lands on the generic ChatGPT page instead of the Codex usage view.
- **Root cause:** `lib/public/modules/app-rate-limit.js` had stale Codex vendor metadata pointing at the generic admin usage URL.
- **Fix:** Updated Codex usage metadata to `https://chatgpt.com/codex/settings/usage` and clarified the link title.
- **Evidence:** `rg` confirms the old `admin/usage` URL is gone from `lib/` and `test/`.
- **Regression test:** Added `test/app-rate-limit-links.test.js`.
- **Verification:** `node --test test/app-rate-limit-links.test.js` and `node --test test/*.test.js` pass.
- **Status:** DONE
