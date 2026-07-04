function attachBridgeMentions(ctx) {
  var adapters = ctx.adapters;
  var adapter = ctx.adapter;
  var cwd = ctx.cwd;
  var mergeMcpServers = ctx.mergeMcpServers;
  var getMcpServers = ctx.getMcpServers;
  var getRemoteMcpServers = ctx.getRemoteMcpServers;
  var checkToolWhitelist = ctx.checkToolWhitelist;

  async function createMentionSession(opts) {
    var abortController = new AbortController();
    var currentOnDelta = opts.onDelta;
    var currentOnDone = opts.onDone;
    var currentOnError = opts.onError;
    var currentOnActivity = opts.onActivity || null;
    var responseFullText = "";
    var responseStreamedText = false;
    var mentionBlocks = {};
    var alive = true;
    var mentionAdapter = (opts.vendor && adapters[opts.vendor]) || adapter;

    var handle;
    try {
      handle = await mentionAdapter.createQuery({
        cwd: cwd,
        systemPrompt: opts.claudeMd,
        model: opts.model || undefined,
        toolServers: opts.includeMcpServers ? (mergeMcpServers(getMcpServers(), getRemoteMcpServers) || undefined) : undefined,
        abortController: abortController,
        canUseTool: opts.canUseTool || function (toolName, input) {
          var whitelisted = checkToolWhitelist(toolName, input);
          if (whitelisted) {
            return Promise.resolve(whitelisted);
          }
          return Promise.resolve({
            behavior: "deny",
            message: "Read-only access. You cannot make changes via @mention.",
          });
        },
        adapterOptions: {
          CLAUDE: {
            settingSources: ["user"],
            includePartialMessages: true,
          },
        },
      });
    } catch (e) {
      opts.onError("Failed to create mention query: " + (e.message || e));
      return null;
    }
    var query = handle;
    var initialPrompt = opts.initialContext + "\n\n" + opts.initialMessage;
    handle.pushMessage(initialPrompt, opts.initialImages || null);

    (async function () {
      try {
        for await (var msg of query) {
          if (msg.yokeType === "thinking_start") {
            mentionBlocks[msg.blockId] = { type: "thinking" };
            if (currentOnActivity) currentOnActivity("thinking");
          } else if (msg.yokeType === "tool_start") {
            mentionBlocks[msg.blockId] = { type: "tool_use", name: msg.toolName, inputJson: "" };
            var toolLabel = msg.toolName;
            if (toolLabel === "Read") toolLabel = "Reading file...";
            else if (toolLabel === "Grep") toolLabel = "Searching code...";
            else if (toolLabel === "Glob") toolLabel = "Finding files...";
            if (currentOnActivity) currentOnActivity(toolLabel);
          } else if (msg.yokeType === "text_start") {
            mentionBlocks[msg.blockId] = { type: "text" };

          } else if (msg.yokeType === "text_delta" && typeof msg.text === "string") {
            responseStreamedText = true;
            responseFullText += msg.text;
            if (currentOnActivity) currentOnActivity(null);
            if (currentOnDelta) currentOnDelta(msg.text);
          } else if (msg.yokeType === "tool_input_delta" && mentionBlocks[msg.blockId]) {
            mentionBlocks[msg.blockId].inputJson += msg.partialJson;

          } else if (msg.yokeType === "block_stop") {
            var blk = mentionBlocks[msg.blockId];
            if (blk && blk.type === "tool_use") {
              var toolInput = {};
              try { toolInput = JSON.parse(blk.inputJson); } catch (e) {}
              if (blk.name === "Read" && toolInput.file_path) {
                var fname = toolInput.file_path.split(/[/\\]/).pop();
                if (currentOnActivity) currentOnActivity("Reading " + fname + "...");
              } else if (blk.name === "Grep" && toolInput.pattern) {
                if (currentOnActivity) currentOnActivity("Searching: " + toolInput.pattern.substring(0, 30) + "...");
              } else if (blk.name === "Glob" && toolInput.pattern) {
                if (currentOnActivity) currentOnActivity("Finding: " + toolInput.pattern.substring(0, 30) + "...");
              }
            }
            delete mentionBlocks[msg.blockId];

          } else if (msg.yokeType === "message" && msg.messageRole === "assistant" && !responseStreamedText && msg.content) {
            var content = msg.content;
            if (Array.isArray(content)) {
              for (var ci = 0; ci < content.length; ci++) {
                if (content[ci].type === "text" && content[ci].text) {
                  responseFullText += content[ci].text;
                  if (currentOnDelta) currentOnDelta(content[ci].text);
                }
              }
            }

          } else if (msg.yokeType === "result") {
            if (currentOnActivity) currentOnActivity(null);
            var doneRef = currentOnDone;
            if (doneRef) {
              doneRef(responseFullText);
            }
            if (currentOnDone === doneRef) {
              currentOnDelta = null;
              currentOnDone = null;
              currentOnError = null;
              currentOnActivity = null;
              mentionBlocks = {};
              responseFullText = "";
              responseStreamedText = false;
            }
          }
        }
      } catch (err) {
        if (currentOnError) {
          if (err.name === "AbortError" || (abortController && abortController.signal.aborted)) {
            currentOnError("Mention query was cancelled.");
          } else {
            currentOnError(err.message || String(err));
          }
        }
      }
      alive = false;
    })();

    return {
      pushMessage: function (text, callbacks, images) {
        currentOnDelta = callbacks.onDelta;
        currentOnDone = callbacks.onDone;
        currentOnError = callbacks.onError;
        currentOnActivity = callbacks.onActivity || null;
        mentionBlocks = {};
        responseFullText = "";
        responseStreamedText = false;
        handle.pushMessage(text, images || null);
      },
      abort: function () {
        try { abortController.abort(); } catch (e) {}
      },
      close: function () {
        alive = false;
        try { handle.close(); } catch (e) {}
      },
      isAlive: function () { return alive; },
    };
  }

  return {
    createMentionSession: createMentionSession,
  };
}

module.exports = { attachBridgeMentions: attachBridgeMentions };
