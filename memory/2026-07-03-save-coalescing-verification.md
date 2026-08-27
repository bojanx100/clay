# Verification: Save Coalescing

- Roadmap item: P1.1.
- ~~Result: No async heavy-session write change was needed.~~
- Evidence: `rg "SAVE-SLOW" ~/.clay/diag-dev.log ~/.clay/diag.log` returned no entries. Recent `~/.clay/diag-dev.log` loop-lag samples were mostly low single-digit milliseconds, with restart/sleep-style outliers not correlated with save diagnostics.
- Follow-up trigger: Revisit async heavy-session writes only if `[SAVE-SLOW]` entries at or above 200ms appear during normal long-session streaming.

> **RETRACTED 2026-08-27:** the trigger fired. Current canaries contained
> repeated `[SAVE-SLOW]` records for 19.9 MB / 40,626-item transcripts, including
> 10.1 s and 6.1 s event-loop stalls. The point-in-time absence above was not
> evidence that the synchronous full-rewrite design was safe. The append-only
> reuse repair and its verification are recorded in
> `memory/2026-08-27-append-only-session-persistence-latency-fix.md`.
