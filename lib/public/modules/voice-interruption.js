// During playback this recognizer can only stop audio. It never forwards
// transcripts to a model, question, permission, or work-control endpoint.
function words(value) { return String(value || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim(); }
export function createVoiceInterruption(options) {
  var opts = options || {}, recognition = null, wanted = false;
  function stop() {
    wanted = false;
    var old = recognition; recognition = null;
    if (old) {
      old.onresult = old.onend = old.onerror = null;
      try { old.abort ? old.abort() : old.stop(); } catch (error) {}
    }
    if (opts.onState) opts.onState(false);
  }
  function start() {
    if (recognition || !opts.createRecognition) return;
    wanted = true;
    var owned;
    try {
      owned = opts.createRecognition();
      if (!owned) { stop(); return; }
      recognition = owned;
      owned.continuous = true;
      owned.interimResults = false;
      if (opts.language) owned.lang = opts.language;
      owned.onresult = function (event) {
        if (recognition !== owned) return;
        var results = event.results || [];
        for (var i = event.resultIndex || 0; i < results.length; i++) {
          if (!results[i].isFinal) continue;
          var text = words(results[i][0] && results[i][0].transcript);
          if (!/^(?:hey )?(?:coop|clay) (?:pause|stop speaking)$/.test(text)) continue;
          // If Clay itself is explaining this command, hearing that playback
          // is not an interruption. The Listen control remains available.
          if (words(opts.echoText ? opts.echoText() : "").indexOf(text) !== -1) continue;
          stop();
          if (opts.onInterrupt) opts.onInterrupt();
          return;
        }
      };
      owned.onerror = function (event) { if (recognition === owned && event.error !== "no-speech") stop(); };
      owned.onend = function () {
        if (recognition !== owned) return;
        recognition = null;
        if (wanted) start();
      };
      owned.start();
      if (opts.onState) opts.onState(true);
    } catch (error) { stop(); }
  }
  return { start: start, stop: stop };
}
