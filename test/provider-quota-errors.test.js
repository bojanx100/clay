var assert = require("assert");
var test = require("node:test");
var isProviderQuotaError = require("../lib/provider-quota-errors").isProviderQuotaError;

test("additional provider quota errors recognize common runtime forms", function () {
  assert.strictEqual(isProviderQuotaError("RESOURCE_EXHAUSTED: free tier quota exceeded"), true);
  assert.strictEqual(isProviderQuotaError("HTTP 429 Too Many Requests"), true);
  assert.strictEqual(isProviderQuotaError("Insufficient credits for this request"), true);
  assert.strictEqual(isProviderQuotaError("Rate limit reached; retry tomorrow"), true);
});

test("ordinary provider and user text is not classified as quota exhaustion", function () {
  assert.strictEqual(isProviderQuotaError("The model discussed quota pricing normally."), false);
  assert.strictEqual(isProviderQuotaError("socket hang up"), false);
  assert.strictEqual(isProviderQuotaError("The answer is 429 lines long."), false);
  assert.strictEqual(isProviderQuotaError(new Array(900).join("x") + " quota exceeded"), false);
});
