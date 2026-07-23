# Debug report: Codex emitted image preview

- **Symptom:** Images emitted from a Codex dynamic tool, including `nodeRepl.emitImage`, appeared as completed tool calls without an inline preview.
- **Root cause:** Codex delivered the result as an MCP-style JSON string containing `content` blocks with `{ type: "image", data, mimeType }`. The Codex adapter only extracted direct `inputImage` content items, so it recorded the base64 JSON as plain text and sent no `images` field to the client.
- **Fix:** Parse MCP-style JSON results at the Codex adapter boundary and convert image blocks to Clay's existing `{ mediaType, data }` image representation while preserving text blocks.
- **Evidence:** The captured failing session contained the exact wrapped payload. The new regression test reproduces that payload and confirms the normalized tool result contains the image. The full test suite passes: 307 tests, 0 failures.
- **Regression test:** `test/codex-adapter-routing.test.js`, "Codex extracts images wrapped in an MCP JSON tool result".
- **Related:** Earlier fixes handled direct Codex `inputImage`, image-generation items, persistence, and client expansion. They did not cover images nested in serialized MCP results.
- **Status:** DONE
