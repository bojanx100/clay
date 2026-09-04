// ESLint flat config used ONLY by the Lead's nightly structural metrics
// runner (scripts/lead-metrics-nightly.js). It is passed explicitly via
// --config; it is NOT the project's lint setup and editors should ignore it.
// One rule: the complexity ceiling from the done-gate.

"use strict";

var COMPLEXITY_CEILING = require("../lib/lead-metrics").COMPLEXITY_CEILING;

module.exports = [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
    },
    rules: {
      complexity: ["error", COMPLEXITY_CEILING],
    },
  },
  {
    files: ["lib/public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
];
