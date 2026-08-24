var createAcpAdapter = require("./acp").createAcpAdapter;

function createGeminiAdapter(opts) {
  return createAcpAdapter("gemini", opts);
}

module.exports = { createGeminiAdapter: createGeminiAdapter };
