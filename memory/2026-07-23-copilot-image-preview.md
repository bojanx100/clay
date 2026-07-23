# Debug report: GitHub Copilot image preview

- **Symptom:** Copilot said it displayed image previews, but Clay showed only a completed tool group without images.
- **Root cause:** Copilot's image viewer returned images under `tool_call_update.rawOutput.binaryResultsForLlm`, while Clay only extracted ACP image blocks from `update.content`. Clay then serialized the raw output, including base64 image data, as plain tool-result text.
- **Fix:** Extract image blocks and the concise status text from Copilot raw tool output when standard ACP content is absent, then pass the images through Clay's existing persistence and rendering pipeline.
- **Evidence:** The failing session stored two raw JSON tool results of 23 KB and 1.2 MB with `binaryResultsForLlm` images but no `images` metadata. The regression test reproduces that exact update shape.
- **Regression test:** `test/copilot-adapter-routing.test.js`, "GitHub Copilot extracts image viewer results from raw output".
- **Related:** Direct ACP `update.content` image blocks were already supported; Copilot's built-in image viewer uses a different raw-output representation.
- **Status:** DONE
