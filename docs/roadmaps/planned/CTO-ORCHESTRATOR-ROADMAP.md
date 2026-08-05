# CTO Orchestrator Roadmap

Status: **planned — design iteration**
Owner: Bojan (ideas / approval), Clay (design + implementation)
Last updated: 2026-07-24

## 1. Vision

One persistent AI "CTO" that manages the whole engineering operation across
**multiple projects**, so the human's input drops to ideas and approvals.

The org chart:

| Role | Who | Responsibility |
|---|---|---|
| Boss | Bojan | Drives ideas, approves plans and merges, reads reports |
| CTO | Persistent orchestrator agent (workspace level) | Owns backlogs across projects, decides what/where/when/how, staffs work, enforces Definition of Done, reports up |
| Team | Specialist AI agents (per project, cross-provider) | Execute bounded tasks: implement, debug, test, review |

Guiding principle (Uncle Bob): **no human reads AI-generated code line by
line.** Trust is transferred from eyeballs to automated gates and metrics.
The human reviews outcomes and gate results, never diffs. The CTO also does
not read lines — he reads gate verdicts.

### 1.1 Reversibility — the CTO is an opt-in module with a kill switch

Hard design constraint (owner decision, 2026-07-24): the CTO may turn out
worse than the current setup. It must therefore ship as a **mode/module on
top of Clay, never a rewiring of Clay**:

- **Server-side setting, off by default.** "CTO mode" is a per-workspace
  setting (server-side per project rules, never localStorage). Enabling it
  grants Coop the management duties; disabling it returns Coop to plain
  coordinator scope (find, triage, switch).
- **Additive-only rule.** No existing flow — sessions, provider switching,
  workers, debate, failover, skills — may be changed to *depend* on the CTO.
  With the mode off, Clay behaves exactly as it does today. Any PR that
  makes a core path require the CTO violates this roadmap.
- **Isolated state.** The CTO's portfolio index, routing records, and
  standup history live in their own storage namespace. Deleting it cannot
  corrupt sessions, projects, or history.
- **Kill-switch semantics.** Disabling mid-flight: delegated worker sessions
  simply become ordinary Clay sessions (they already are); queued CTO
  actions are dropped; nothing needs migration or cleanup to keep working.
- **Salvage value.** The pieces with standalone worth are deliberately built
  *outside* the module: done-gate metrics tooling (§5.1), Live UI's
  verification manifest, the Voice kernel, cross-provider worker routing.
  If the orchestration concept fails, only the routing brain and standup
  composer are discarded — everything else remains in daily use.
- **Branching policy (owner decision, 2026-07-24).** Development lands on
  `bojan` behind the CTO-mode flag — no long-lived feature branch. The
  additive-only rule is proven per-commit (suite green with the flag off);
  a big branch would verify it once, at merge time, while rotting against
  `bojan`'s regular upstream merges. Risky experiments use short-lived
  spike branches/worktrees that are thrown away and re-implemented cleanly.
  Rule of thumb: branches isolate unfinished code; flags isolate unproven
  behavior — the CTO's risk is behavioral, so the flag is the tool.

## 2. Prerequisite: Phase 0 — Harden what exists

Before any CTO work starts, Clay's existing features must be **optimised,
easy to use, and working**. The CTO is built entirely on these primitives;
building a manager on top of flaky machinery multiplies the flakiness.

Phase 0 scope (audit + fix, feature by feature):

- **Provider switching** (`lib/provider-switch.js`, `lib/provider-command.js`,
  `lib/switch-provider-mcp-server.js`) — every trigger path works: `/provider`,
  `/switch`, model-requested, outage failover. Handoff context arrives intact
  on the new provider.
- **Handoff packages** (`lib/handoff-package.js`, `lib/handoff-context.js`) —
  transcript replay is correct, sized to target context window, decay behavior
  (4 turns, 1 for Copilot) is intentional and documented.
- **Worker delegation** (`lib/provider-agent-pipeline.js`) — Codex→Terra and
  Claude→Opus delegation is reliable; `WORKER_STATUS` / `ESCALATION_REQUIRED`
  contracts are honored; sub-agent activity renders correctly in the UI
  (`lib/sdk-message-processor.js`, `lib/public/modules/tools-subagents.js`).
- **Debate engine** (`lib/project-debate.js`, `lib/debate-mcp-server.js`) —
  moderator + multi-provider panelists work end to end; this is the CTO's
  architectural template.
- **Provider failover** (`lib/project-provider-failover.js`,
  `lib/provider-health.js`) — health scoring and auto-continue verified.
- **Stability canaries** — `~/.clay/recovery-events-dev.log` and
  `~/.clay/diag-dev.log` quiet under normal operation (per
  `docs/guides/DIAGNOSTICS.md`). No stalls, phantom reconnects, resume spam.
- **Ease of use** — each of the above usable without reading source: discoverable
  commands, clear status output, sane errors.

Exit criteria for Phase 0: every feature above has (a) a passing verification
run, (b) quiet canaries, (c) a short usage doc or `--help`-grade discoverability.
Phase 0 findings feed the first real backlog the CTO will later manage.

## 3. Architecture

### 3.1 Two tiers

Clay is per-project today (daemon → project → sessions). The CTO is a
**workspace-level** role — the main net-new piece.

```
Bojan (ideas, approvals)
  │
  ▼
CTO agent (workspace level — NEW)
  │  portfolio backlog · routing decisions · gate enforcement · reporting
  │
  ├─► Project A: worker agents (existing per-project machinery)
  ├─► Project B: worker agents
  └─► Project C: worker agents
```

Precedents already in the codebase:

- The **debate engine** proves one agent can spawn and coordinate multiple
  sessions, each on its own vendor.
- The SDK already exposes a `coordinator` message origin
  (`docs/ongoing/SDK-UPGRADE.md`) — plumbing for "message from coordinator" UX.
- The **"Coop" concept** (`docs/roadmaps/planned/VOICE-CONVERSATION-ROADMAP.md`)
  already sketches a workspace-level coordinator; the CTO is its text-first
  realization.

### 3.2 The CTO loop

Runs on the Ralph Loop pattern (`clay-ralph`: `PROMPT.md` mission +
`JUDGE.md` done-criteria), continuously while enabled:

1. **Scan** all project backlogs → unified portfolio view.
2. **Pick** the highest-value item (priority, risk, dependency order,
   staleness, Bojan directives).
3. **Propose** (for big items): post a plan, wait for approval. Small,
   low-risk items flow without asking (see §6 autonomy dial).
4. **Staff**: route the item to the right agent/provider (§4).
5. **Verify**: run the full Definition of Done gate (§5). Failures go back
   to the team, not to Bojan.
6. **Report**: push notification for actionable events; everything else
   batches into the daily standup (§7).
7. Repeat.

### 3.3 Backlog sources

Multiple projects, multiple sources — the CTO aggregates:

- **GitHub Issues** per repo (via `gh`) — durable, PR-linked, shareable.
- **Clay Tasks** (TaskCreate/TaskList) — for Clay-internal work.
- **Chat directives** — Bojan drops an idea in the CTO chat; the CTO turns it
  into a tracked backlog item in the right project (never keeps it only in
  conversational memory).

The CTO maintains a single portfolio index (per-project item lists + status +
metric trends) persisted server-side.

## 4. Routing brain — "who should do what"

The missing piece the CTO needs. Inputs already exist:

- **Capability tiers** — `lib/model-capability.js`
- **Provider health** — `lib/provider-health.js`
- **Routing heuristic (as prose)** — `lib/model-recommendations.js`:
  Fable for ambiguous product/design/architecture judgment; Opus for hard
  implementation/debugging/security; Sonnet for everyday work; Haiku for
  quick low-risk mechanical tasks; GPT-5.6 Sol for deep Codex work;
  Terra/Luna for everyday/fast Codex work.

Work needed:

1. **Codify the heuristic** into a decision function: task classification
   (bug / feature / research / chore / design), risk, blast radius, expected
   effort → provider + model + verification depth.
2. **Lift the same-family constraint** in `lib/provider-agent-pipeline.js`
   (today: Codex→Terra, Claude→Opus only) so the CTO can staff
   cross-provider: e.g. a Fable CTO hiring a Sol coder and a Haiku
   mechanical-edit worker on the same item.
3. **Cost/speed table** per route so the CTO defaults to the *cheapest
   capable* agent, escalating tier only on failure or flagged difficulty.
4. **Learning loop** (later): track per-route success/failure by task class;
   feed outcomes back into routing choices.

CTO model choice: **Fable** for the CTO itself (decomposition, routing
judgment, integration are its strengths); Sol is better spent as the heavy
coding worker. Revisit for cost — a cheap triage layer may front the CTO so
trivial turns never pay the premium tier.

## 5. Definition of Done — the non-skippable gate

Two layers, **both mandatory**. An item is Done only when every gate is green.
Failures loop back to the team automatically; Bojan only sees green, blocked,
or needs-decision.

### 5.1 Structural health (the Uncle Bob layer)

Automated, objective, hard-to-game metrics:

| Metric | Tool | Gate |
|---|---|---|
| Test coverage | `c8` / `nyc` | Threshold per project; never decreases |
| Mutation score | Stryker | Nightly portfolio job (too slow per-item); regressions surface in standup |
| Cyclomatic complexity | ESLint `complexity` rule | Hard cap on new/changed functions |
| Module size | max-lines check | Codifies the existing 500-line rule from CLAUDE.md — moved from "agent promises" to "gate refuses" |
| Dependency structure | `dependency-cruiser` | Enforce architecture rules (e.g. client modules never `require`, server never `import`, no cycles) |

Mutation testing is the key anti-gaming metric: AI-written tests can fake
coverage but cannot easily fake a mutation score.

### 5.2 Behavioral truth (the QA layer)

Uncle Bob's metrics answer "is this code healthy?" — not "does it do what
Bojan wanted?" This layer answers the second question:

- **`verify`** — exercise the change end to end, observe real behavior.
- **`qa` / `browse`** — drive the live UI headlessly; the feature must
  actually work in the running app, not only in tests.
- **`code-review` (AI reviewer)** — intent and security review. Note: still
  no human reading lines; a reviewer agent reads, only its verdict surfaces.
- **Canaries quiet** — per `docs/guides/DIAGNOSTICS.md`, a fix is not done
  until `~/.clay/recovery-events-dev.log` and `~/.clay/diag-dev.log` are
  quiet.

### 5.3 Gate mechanics

- Gate execution is scripted/deterministic (not model judgment) wherever
  possible; the CTO cannot mark Done without a green gate artifact.
- Gate results are persisted per item (what ran, verdicts, metric deltas) —
  this is what Bojan reviews instead of diffs.

## 6. Autonomy dial — propose & approve

Chosen mode: **propose & approve** while trust calibrates.

| Event | Small / low-risk item | Big / risky item |
|---|---|---|
| Start work | CTO proceeds, logs it | CTO posts plan, **waits for approval** |
| Merge / ship | Stacks PR, batched approval | **Explicit approval required** |
| Blocked / ambiguous | Push notification, waits | Push notification, waits |

Risk classification (what makes an item "big"): schema/data migrations,
auth/security surface, provider/daemon core paths, public API changes,
anything irreversible. Everything else defaults small.

The dial widens over time: Phase 2 = auto up to merge; Phase 3 = optional
auto-merge on green gates. Loosening is a deliberate decision after the gate
has visibly caught real problems.

Hard safety rails (inherit existing Clay defenses):

- Model-initiated provider switches keep the user-confirmation gate
  (`lib/provider-switch-request.js`) — the CTO staffs via **sub-agents**,
  not by hijacking the chat's provider.
- Per-repo rules stay absolute (e.g. this repo: commit/push only to `bojan`,
  never PR/merge/comment without explicit ask).

## 7. Reporting — two tiers

### 7.1 Push (interrupt Bojan now)

Only genuinely actionable events:

- Blocked: a decision only Bojan can make
- Approval needed: big-item plan, or PR ready to merge
- Incident: canary tripped, provider outage affecting in-flight work

Channel: `PushNotification`.

### 7.2 Daily standup digest (batched, low noise)

Once per day in the CTO chat:

- Shipped since last standup (per project, with gate summaries)
- In flight (who's on what, on which provider)
- Blocked / waiting on Bojan
- Metric trends: coverage, mutation score, complexity, module-size, canary
  counts — per project (this is where "managing by the numbers" lives)
- Tech-debt reminders derived from metric trends, not memory

## 8. Existing primitives inventory

What the CTO composes (all present today):

| Primitive | File(s) | Role in CTO design |
|---|---|---|
| Single switch executor | `lib/provider-switch.js` | Any-path provider changes |
| Model-asks-user-approves | `lib/switch-provider-mcp-server.js`, `lib/provider-switch-request.js` | Safety pattern to reuse for approvals |
| Handoff context | `lib/handoff-package.js`, `lib/handoff-context.js` | Context transfer on switch |
| Worker delegation | `lib/provider-agent-pipeline.js` | Team execution (needs cross-provider lift) |
| Multi-provider orchestration | `lib/project-debate.js`, `lib/debate-mcp-server.js` | Template: one agent driving many vendor sessions |
| Auto failover routing | `lib/project-provider-failover.js`, `lib/provider-health.js` | Health-aware route scoring |
| Routing heuristic (prose) | `lib/model-recommendations.js` | Seed for the routing brain |
| Capability comparison | `lib/model-capability.js` | Tier-aware model matching |
| Autonomous loop | `clay-ralph` skill (`PROMPT.md` + `JUDGE.md`) | The CTO's heartbeat |
| Verification skills | `verify`, `qa`, `browse`, `code-review`, `canary` | Done-gate behavioral layer |
| Coordinator message origin | SDK (`docs/ongoing/SDK-UPGRADE.md`) | "From coordinator" UX plumbing |

## 9. Hard constraints to design around

- **One active provider per session-turn.** A chat session binds to one
  vendor at a time; the CTO therefore orchestrates via sub-agents/sessions,
  not rapid in-chat switching.
- **Context transfers as replayed text** (handoff package), decaying after
  ~4 turns — workers get scoped briefs, never "the whole conversation."
- **Projects are isolated by design** (separate daemons/sessions). The
  workspace coordination layer must see into projects without collapsing
  that isolation.
- **Cost**: an always-on premium CTO pays premium on trivial turns.
  Mitigation: cheap triage front, or CTO wakes on events/schedule rather
  than polling.
- **Workers must not sub-delegate** (existing pipeline rule) — keeps the
  org two levels deep and debuggable.

## 10. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Harden** | Audit + fix existing features (§2) | All §2 features verified working, canaries quiet, usable without reading source |
| **1 — One project, one item** | CTO reads one project's backlog, proposes, staffs one item, runs full done-gate, reports | ✅ **DONE 2026-08-03**: "restart with same brief" (from Phase 0 carry-over) went portfolio → classify → route (codex/terra tier 3) → staff (delegate_task) → full gate (suite 503/503 Lead-verified, regression test, boundaries held, canaries explained) → standup. Owner touched it exactly twice (approve staffing, accept result); no human read a line of the diff. Modules: lead-routing, lead-backlog, lead-staffing, lead-standup + leadMode flag — all additive-only. |
| **2 — Full queue, one project** | Ralph-Loop-driven queue processing, cross-provider staffing, nightly metrics, daily standup | A week of queue processing with gates catching ≥1 real problem; standup accurate |
| **3 — Portfolio** | Workspace-level CTO across all projects; unified backlog; portfolio metrics | Multi-project standup; correct cross-project prioritization |
| **4 — Widen autonomy** | Auto-to-merge, then optional auto-merge on green | Deliberate loosening only after demonstrated gate reliability |

## 11. Related initiatives — Voice (Coop) and Live UI

The CTO is one of three planned initiatives that form a single product:

| Initiative | Doc | Role | Ships as |
|---|---|---|---|
| CTO Orchestrator | this doc | The brain: who does what, when; gates; reporting | **Opt-in module** (§1.1), off by default |
| Voice / Coop | `VOICE-CONVERSATION-ROADMAP.md` | The boss's interface: talk, approve, standups, triage | Core feature set |
| Live UI | `LIVE-UI.md` | The hands-on surface: point at the real app, detail design, fix issues in real time | **Core feature set** — independent of CTO mode |

Binding decisions (recorded here so neither track builds a duplicate):

1. **Shared Phase 0.** The Voice doc's "Reliability Baseline" (quiet
   canaries, diagnostics, gated phase exits) and this doc's §2 Phase 0 are
   the same requirement. One hardening pass is the precondition for all
   three initiatives.
2. **The CTO is Coop's management brain — gated by CTO mode.** Coop
   (workspace coordinator, persistent daemon-level coordination channel,
   `server-coordination.js`) is how the boss talks to the CTO; the CTO loop
   (§3.2) is what the same entity does between conversations. This resolves
   the "where does the CTO live" question: daemon-level, on the Coop
   coordination channel — not an HQ project. One entity, two power levels:
   with CTO mode off, Coop is a plain coordinator (find, triage, switch);
   enabling the mode grants backlog ownership, routing, gate enforcement,
   and reporting duties.

   **Persona and naming (owner decision after Mate debate, 2026-08-01):**
   one person, not two. The user talks to their lead — a second named
   entity would push a routing decision ("who do I address?") onto the
   human, the exact load this design removes. Naming follows a
   person-vs-hat split: the *person* keeps one stable name across modes
   (a name that changes with permissions confuses); **"Lead" is the role
   label**, not a proper name — UI badge `Coop — Lead`, spoken "my lead" /
   "ask the lead". Price of unification, binding rule: **the Lead
   connects, never gatekeeps** — "get me Ward" hands the user directly to
   Ward with no summarizing middleman, in every mode. (The naming debate's
   two-entity reading of Coop-vs-Lead is superseded by this resolution.)
3. **The CTO's behavioral done-gate adopts Live UI's evidence contract.**
   Live UI's operation journal, typed verification manifest ("agent prose is
   not verification evidence"), and formal result states (including
   reproduce-before / pass-after for bug fixes) become the CTO's
   §5.2 evidence format. No parallel verification schema. Dependency
   direction is one-way: Live UI is a core feature that never depends on
   CTO mode; the CTO (when enabled) is a *reader* of its artifacts.
4. **The CTO's approvals adopt the Voice conversation gateway.** Immutable
   plan versions, amend-then-approve, typed human-input provenance
   (machine-injected input can never approve, confirm done, or answer
   destructive confirms) apply to CTO propose-&-approve identically. The
   CTO can *recommend*; only daemon-verified live-human input authorizes.
5. **Executor snapshots are shared.** The Voice snapshot schema
   (`conversation-snapshot.js` — lifecycle, currentStep, needsYou, git
   state, decisions[], verification) is exactly what the CTO reads to track
   the team and compose standups. One schema, two consumers.
6. **Closed loops.** Live UI selections can file items into the CTO's
   backlog; CTO design items ending "Changed, needs review" surface to the
   boss as Live UI review sessions; Coop speaks the daily standup and takes
   spoken approvals.
7. **Three-axis model (owner decision, 2026-08-04).** Scope, initiative,
   and channel are separate axes; "two power levels" understates it.
   - *Scope*: one agent above all projects (the Coop/Lead space).
   - *Initiative*: a **dial per decision class**, not a binary. The
     approval gate sits at **backlog admission**: work is discussed with
     the boss (plan, iterate, check — confirm goals, straighten problem
     understanding) and admitted to the backlog; once admitted, execution
     is autonomous — no per-item "may I take it". The boss's touchpoints
     are plan/goal discussions and accepting verified results, not
     dispatch. Classes are promoted from gated to autonomous as measured
     trust (backtest alignment, gate pass rate) earns it. Self-modification
     and spend beyond the budget dial stay approval-class regardless.
   - *Channel*: text or voice carry the SAME decision engine, but
     autonomy is **not channel-blind**: trust is measured per class ×
     channel (voice approvals review less evidence, so voice-gated classes
     promote more slowly), and reports must compose per channel (a spoken
     digest is not a rendered table).
   - *Trust evidence hardening (admitted slice)*: the Lead ledger records
     typed `trust_observation` events with `decisionClass`, `channel`
     (`text`/`voice`), one of `gate_pass`, `backtest_alignment`, or
     `refusal_correctness`, a boolean outcome, timestamp, and evidence.
     Aggregation never crosses either axis. Channel-less records are a
     compatibility migration to `text` only when they are explicitly typed
     trust observations; unrelated ledger events are ignored. Promotion
     remains disabled without an injected class × channel policy and enough
     samples for every metric, so collecting evidence never silently changes
     autonomy. The nightly report renders the deterministic trust section;
     structural done-gate verdicts remain unchanged unless a policy is
     explicitly supplied.
   - **Stale-premise rule (binding)**: decisions must never execute
     against stale state. Before acting on any command or queued
     decision, Coop re-derives current state (in-flight work, provider
     health, item status); when a command's premise has expired — the
     item is done, superseded, blocked, or reality moved since the boss
     last looked — Coop refuses and re-confirms instead of executing.
     Commands inherit the boss's context staleness; the refusal duty is
     what makes admission-time approval safe.

Sequencing consequence: the CTO is the **capstone**, not a parallel track.
Voice Phase 1a (text-only kernel: ledger, typed gateway, snapshot,
provenance) and Live UI Phases 0-4 (operation journal + verification
manifest) build most of the CTO's substrate. CTO-specific net-new work
shrinks to: the routing brain (§4), cross-provider worker lift, portfolio
backlog aggregation, and the standup composer.

## 12. Open questions (iterate here)

1. ~~**Where does the CTO live?**~~ Resolved (§11.2): daemon-level, as
   Coop's management brain on the coordination channel.
2. **Cross-project access mechanism** — how does an HQ session enumerate and
   message other projects' sessions? (Debate engine does it within one
   project; needs a workspace-scoped equivalent.)
3. ~~**Metric thresholds**~~ Resolved (Mate debate, 2026-08-01 —
   Arch/Ward/Rush panel, unanimous): **ratchet, not fixed numbers — with
   a hard floor and escape hatches.** "Never worse than the last green
   build", so every project climbs from its own real baseline. Concretely:
   - *Per commit (fast)*: mutation-test only changed files against a
     floor; coverage never below last-green minus a small slack; no new
     file over the complexity ceiling.
   - *Nightly (slow)*: full mutation run averaged over the last 5 green
     builds — fails only on sustained drops, not noise.
   - *Slack budget*: ~2 coverage points/week for honest refactors —
     logged, auto-refilling, never silent.
   - *Day-one values*: Clay — mutation floor 70, coverage frozen at
     current level; new apps — mutation floor 45, coverage ratchet from
     the actual baseline (~30%).
   - *Core principle*: let the agent flex the gameable metric (coverage)
     but hold the line on the un-gameable one (mutation score) — that is
     what keeps the gate trustworthy when no human reads the code.
4. **Copilot's role** — with a 1-turn handoff budget and no worker route
   today, where does Copilot fit in the team?
5. **Standup delivery** — CTO chat only, or also push/Slack once Slack is
   wired?
6. **Budget controls** — per-day or per-item token/cost ceilings the CTO
   must respect when staffing.
7. **Phase 0 backlog** — the audit will produce findings; do these become
   the CTO's first supervised backlog (dogfooding Phase 1 on Clay itself)?
8. **Cross-initiative sequencing** — within the shared substrate, what is
   the exact interleaving of Voice 1a (text kernel), Live UI 0.1
   (Clay-on-Clay loop), and CTO Phase 1 (one project, one item)? Proposal:
   shared Phase 0 hardening → Voice 1a and Live UI 0.1 in parallel →
   CTO Phase 1 on top of both.
