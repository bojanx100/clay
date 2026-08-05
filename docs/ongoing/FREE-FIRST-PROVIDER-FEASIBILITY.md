# Free-First Provider Routing Feasibility

**Status:** Deferred — accepted as a future direction, with no implementation scheduled

**Investigated:** August 5, 2026

**Decision recorded:** August 5, 2026

**Decision question:** Is there enough legitimate, useful free AI capacity for Clay to route work across providers, or should this remain a future idea?

## Decision

Keep the free-first provider direction on record and defer implementation. No ACP adapter, provider integration, or benchmark is scheduled by this document.

When the idea is deliberately revisited, begin with the experimental ACP host and benchmark described below. Revalidate every provider's pricing, quota, access, and data policy before turning this research into an implementation plan.

## Executive conclusion

There is enough free AI available now to justify a small integration and evaluation spike. There is not enough stability to promise unlimited or uninterrupted free AI.

The strongest near-term opportunity is:

1. Use **Gemini CLI Free** as the anchor. Its published allowance of 1,000 model requests per user per day is materially larger than the other durable free plans.
2. Build one reusable **Agent Client Protocol (ACP) host** instead of a Kiro-specific integration. The same host can launch Gemini CLI, Mistral Vibe, and Kiro CLI.
3. Keep Clay's existing Codex and GitHub Copilot routes as additional free pools when the user has those entitlements.
4. Treat OpenRouter, GroqCloud, OpenCode Zen, and local models as optional experimental pools behind a generic model endpoint or agent harness.
5. Do not advertise this as “free AI forever.” Call it **free-first** or **budget mode**: prefer available zero-cost capacity, stop before spending, and ask before using paid overage.

This conclusion is based on provider documentation and Clay's current architecture, not a hands-on cross-provider coding benchmark. Quality and quota behavior still need to be measured before a product commitment.

## What counts as a candidate

A provider belongs in the main comparison only if it has:

- recurring access at $0, rather than only a one-time trial;
- enough capability for agentic work, not only inline completion;
- a supported integration surface such as ACP, a structured/headless CLI, an SDK, or a compatible API;
- user-owned authentication, without shared accounts or repackaged provider credentials.

Free web chat alone does not make a provider integrable. Clay needs a supported way to control the agent or model while preserving the user's own account and terms.

## Clay's starting position

Clay already contains most of the control plane required for free-first routing:

- `lib/provider-routes.js` describes executable provider routes and live model entitlements.
- `lib/provider-health.js` records health, quota unavailability, and reset times.
- `lib/project-provider-failover.js` chooses a healthy, comparable alternative and prevents failover loops.
- Provider switching uses a handoff context so work can continue at a turn boundary instead of restarting.
- GitHub Copilot model availability is already discovered from live entitlements.

The missing work is primarily a broader provider transport layer plus policy metadata: free/paid status, quota type, remaining capacity, privacy restrictions, and whether a route can ever incur a charge.

## Recurring free options

The usefulness ratings are provisional desk assessments:

- **High potential:** should be capable of real repository tasks, subject to a benchmark.
- **Medium:** useful for real but bounded tasks; capacity, model quality, or integration limits sustained work.
- **Low:** mainly an occasional reserve.
- **Experimental:** useful capacity exists but cannot be treated as durable.

| Provider | Current free allowance | Adjacent paid tier | Clay integration surface | Coding usefulness at $0 | General-task usefulness at $0 | Recommendation |
|---|---|---|---|---|---|---|
| **Gemini CLI** | 1,000 model requests/user/day with Google sign-in; 250/day with a free API key | Google AI Pro: $19.99/month, 1,500/day | **ACP** (`gemini --acp`), headless CLI | **High potential.** Enough published daily capacity for meaningful use; one user prompt may consume several model requests | **High potential.** Shell, web, MCP, skills, and extensions broaden it beyond coding | **First new provider** |
| **OpenAI Codex** | $0 plan for “quick coding tasks”; exact usage cap is not published | Go $8; Plus $20; Pro from $100 | Already integrated; structured CLI/app server | **High quality, low/unknown capacity.** Suitable for quick tasks, not a dependable daily pool without measured limits | **Medium.** Capable, but the free plan is positioned around quick coding | Keep and label live entitlement accurately |
| **GitHub Copilot** | 2,000 completions and 50 chat requests/month; CLI included | Pro $10; Pro+ $39; Max $100 | Already integrated; structured CLI and live entitlements | **Medium quality, low capacity.** Fifty agent requests can complete occasional real tasks but not daily work | **Medium-low.** Coding-focused and quota-constrained | Keep as an existing reserve |
| **Mistral Vibe** | Limited messages, web searches, and coding sessions; no numeric public quota | Pro $14.99/month for more usage and all-day coding | **ACP**, structured CLI, sessions, generic OpenAI-compatible endpoints | **High potential, unknown capacity.** Purpose-built agent with shell, repository access, tests, and resumable sessions | **High potential.** Web search, connectors, skills, and MCP are included | **Second ACP provider**, benchmark quota behavior |
| **Kiro CLI** | Perpetual 50 credits/month; credit cost varies by task/model | Pro $20/1,000 credits; Pro+ $40; Pro Max $100; Power $200 | **ACP** (`kiro-cli acp`) | **High quality, low capacity.** Frontier and open-weight models can do serious tasks, but 50 variable credits are a reserve | **Medium.** Agent skills, MCP, and general shell work are supported | Add after generic ACP exists; do not build a Kiro-only host |
| **GroqCloud API** | Model-specific free limits; for example GPT-OSS 120B currently has 1,000 requests and 200,000 tokens/day | Developer is usage-priced | OpenAI-compatible API; rate-limit headers | **Medium.** Fast, useful for explanation, planning, and small edits; daily token caps constrain repo-scale loops | **High for short work.** Strong fit for Q&A, summaries, and transformations | Later generic endpoint, not a native agent route |
| **OpenRouter** | 25+ rotating free models and 50 requests/day; 1,000/day only after at least $10 of credits has been purchased | Pay as you go | OpenAI-compatible API and free-model router | **Medium/variable.** A good model plus an agent harness can do real tasks, but availability and tool support vary | **Medium.** Useful for light fallback work | Experimental generic gateway; never silently cross into paid models |
| **Local open-weight models** | No provider charge or quota; hardware and electricity are the cost | User-owned hardware or hosted inference | Codex `--oss` supports Ollama/LM Studio; Vibe supports generic endpoints | **Medium on common hardware; potentially high on large hardware.** GPT-OSS 20B needs about 16 GB memory; 120B about 80 GB | **High for private, repeatable short work** when latency is acceptable | First-class optional pool, not a universal default |
| **OpenCode Zen free models** | Several models are currently free, each explicitly “for a limited time” | Usage-priced models and credits | OpenAI/Anthropic-compatible endpoints; OpenCode agent harness | **Experimental.** Some models are coding-oriented, but the roster changes and free-period data policies vary | **Experimental.** Useful while promotions last | Opt-in lab pool only; re-check dynamically |
| **Cursor Hobby** | Limited Agent requests; no public numeric quota | Pro $20/month | Beta agent CLI with structured output; no documented ACP route | **Potentially useful, capacity unknown.** The free allowance is too opaque for routing guarantees | **Low-medium.** Product remains coding-oriented | Monitor; not first-wave work |
| **Devin Desktop / Windsurf Free** | “Light quota” for agents, limited models, unlimited inline edits and Tab; no numeric public quota | Pro $20/month | Desktop/local agent; supported external control is less clear than ACP CLIs | **Potentially useful, capacity unknown.** Good end-user product, weak Clay integration case today | **Low-medium.** Coding-first | Monitor for a stable headless or agent protocol surface |

### Existing Anthropic route

Claude has a $0 web plan for occasional use, but Anthropic documents Claude Code access on paid Pro and Max plans. Pro is $20/month, Max 5x is $100/month, and Max 20x is $200/month. Therefore Clay's existing Anthropic/Claude Code route is excellent when a user already pays for it, but it is not a current zero-cost coding route. Free Claude web code execution is not a supported replacement for controlling Claude Code from Clay.

## Options that should not drive the design

| Option | Why it is not a current baseline |
|---|---|
| **Amazon Q Developer CLI** | AWS still lists 50 free agentic requests/month, but its open-source CLI is no longer actively maintained and directs users to Kiro CLI. Integrating both would duplicate the same product lineage. |
| **Qwen Code OAuth** | Its 1,000-request/day free tier was discontinued on April 15, 2026. Qwen Code can still host paid, third-party, or local endpoints, but it no longer contributes its own durable free pool. |
| **Amp Free** | Existing admitted users retain a very generous allowance, but admission is closed to new users. This is valuable for grandfathered users, not a general Clay feature. |
| **Cerebras** | The “Free Trial” is a one-time $5 credit, not recurring free capacity. |
| **Short-lived launch promotions** | They can be exposed as experimental routes, but should never be counted when Clay promises availability. |

These examples matter because they show how quickly a free tier can disappear. Qwen's allowance ended and Amp stopped new admission within months. Clay should discover current entitlements and fail safely instead of hard-coding a marketing promise.

## Can good work actually be done for free?

### Coding

Yes, with limits.

- **Small and medium repository tasks:** Gemini Free appears large enough for regular use. Mistral Vibe, Codex Free, Copilot Free, and Kiro should each handle genuine fixes or reviews, but their free capacity is either small or unpublished.
- **Large refactors and autonomous loops:** no hosted free tier should be assumed to sustain these. Long contexts, retries, test runs, subagents, and compaction can turn one visible prompt into many metered requests.
- **Local work:** a 16 GB machine can run GPT-OSS 20B, which OpenAI compares to o3-mini on common benchmarks. That is credible for code explanation, tests, targeted changes, and private work. It is not a drop-in replacement for the strongest hosted coding agents on ambiguous, multi-file tasks. GPT-OSS 120B is stronger but requires approximately 80 GB of memory.
- **Quality after failover:** switching to a nominally free model is only useful if it preserves the capability needed by the task. Clay's existing comparable-model selection is the correct base, but the capability table needs empirical data for new providers.

### General work

The same pool can do more than coding when the hosted agent exposes the right tools.

- Gemini and Vibe include web or connector capabilities, shell access, MCP, and skills.
- Kiro supports MCP, agent skills, and general terminal operations.
- Groq, OpenRouter, and local models can perform writing, summarization, classification, planning, and research synthesis, but an API model is not an agent by itself. Clay or a reusable harness must provide tools and safe execution.
- Local models are especially useful for private summarization, classification, extraction, and repetitive transformations where frontier reasoning is unnecessary.

The practical product is therefore not “pick the cheapest model.” It is “pick the best available route that is free, capable enough for this task, allowed to see this data, and unlikely to stop before completion.”

## Why ACP is the right first abstraction

Gemini CLI, Mistral Vibe, and Kiro CLI all expose ACP over JSON-RPC and standard input/output. Their core methods cover initialization, authentication, session creation/loading, prompting, cancellation, streaming updates, and model or mode selection.

A single Clay ACP host could own:

- process lifecycle and authenticated-user checks;
- session creation, resume, and cancellation;
- streaming text and tool-call normalization;
- filesystem proxy permissions;
- provider-specific capability descriptors;
- error, quota, and reset normalization into `provider-health`;
- handoff into and out of existing Clay sessions.

Provider-specific adapters should be thin descriptors around that transport. A one-off Kiro process/session implementation would create three versions of almost the same protocol and make future ACP agents expensive to add.

ACP does not solve quota discovery or billing safety. Those remain explicit Clay responsibilities.

## Product requirements if this proceeds

### Zero-spend guarantee

Free-first mode should have a hard default invariant:

> Never incur a provider charge without explicit user permission.

That means:

- use only the user's own subscription, account, API key, or local model;
- do not share or resell provider capacity;
- keep paid overage disabled by default;
- never change a provider's auto-reload or billing settings automatically;
- distinguish “included in my subscription,” “recurring free,” “temporary promotion,” “local,” and “pay as you go”;
- stop and explain when no eligible route remains;
- require an explicit, separately stored server-side opt-in before a paid fallback is considered.

Some tools can continue on API billing after subscription capacity is exhausted. An environment API key can also cause a CLI to bill the API instead of using a subscription. Clay must detect the actual authentication path where possible and treat unknown billing state as ineligible for zero-spend routing.

### Quota and health model

Each route needs live or best-known metadata such as:

```text
cost class: recurring-free | included-subscription | temporary-free | local | paid
quota confidence: live | published-static | inferred | unknown
remaining/reset: value if the provider exposes it
paid overage possible: yes | no | unknown
privacy class: user-approved data policy
capability tier: empirically measured, not only model-name based
```

Use official entitlement or quota signals when providers expose them. Groq publishes rate-limit headers, Copilot already exposes live entitlements, and Gemini exposes session usage statistics. When a provider exposes no machine-readable quota, Clay should mark it unknown and react to supported rate-limit errors rather than scrape dashboards.

### Privacy-aware routing

Zero price is not the only constraint. Free endpoints can have different retention or model-training policies, and free promotional models can be explicitly unsuitable for confidential data. A user should be able to require, for example:

- local-only;
- no training on prompts;
- zero data retention;
- approved providers only;
- no third-party gateway.

If no free route satisfies those constraints, Clay should stop instead of quietly relaxing privacy.

### Switching semantics

Provider switching should occur at a task or turn boundary with Clay's structured handoff. It should not attempt to swap models in the middle of a streamed response. The current failover budget, provider health registry, comparable-capability check, and no-ping-pong behavior should remain in force.

## Recommended validation before an implementation plan

The smallest worthwhile next step is an **experimental ACP host plus a benchmark**, not a polished “free mode.”

1. Implement the minimum reusable ACP transport behind a feature flag.
2. Connect Gemini first, then verify the same transport with Mistral Vibe and Kiro.
3. Run the same tasks on each free entitlement:
   - explain a non-trivial subsystem without edits;
   - fix a small bug and run focused tests;
   - make a multi-file refactor with constraints;
   - perform a general research/synthesis task using available tools;
   - hit or simulate quota exhaustion and continue through Clay handoff.
4. Record task success, human corrections, requests/credits consumed, wall time, tests, diff quality, and whether quota/reset information was observable.
5. Require two independent recurring-free routes to pass the small-task suite before presenting free-first routing as a normal product mode.

### Decision after the benchmark

Proceed to a full product plan only if:

- Gemini's real request consumption leaves useful daily capacity;
- at least one other recurring free pool reliably completes small coding tasks;
- ACP process/session behavior is stable under cancellation and concurrency;
- Clay can enforce zero spend even when provider authentication is ambiguous;
- privacy and capability policies can prevent unsafe or obviously weak fallback.

Otherwise, retain the ACP adapter as useful infrastructure, keep the provider research, and re-evaluate the market quarterly.

## Recommendation

**Build the small ACP/evaluation foundation now; defer the full free-first product promise until the benchmark passes.**

This is a better timing point than waiting for hypothetical future free AI because:

- Gemini already offers a material recurring quota;
- three credible agents now share one protocol;
- Clay already has provider health, comparable failover, and handoff infrastructure;
- the ACP host remains useful for paid user-owned providers even if free tiers change.

The product message, if validated, should be:

> Clay uses the AI access you already have, prefers zero-cost routes, and never spends without permission.

It should not be:

> Clay gives you unlimited AI for free.

## Revisit triggers

Re-run this investigation when any of the following occurs:

- Gemini changes its 1,000-request free allowance;
- Mistral or Codex publishes numeric free limits;
- another major coding agent adopts ACP;
- Amp Free reopens or an equivalent frontier-model program opens broadly;
- a strong open-weight coding model becomes practical on 16-32 GB consumer hardware;
- a provider exposes a supported quota/entitlement API Clay can consume;
- the experimental benchmark shows free tiers are exhausted much faster than published request counts imply.

## Official sources

Sources were checked on August 5, 2026. Provider plans are volatile and should be revalidated before implementation or public claims.

### Primary candidates

- OpenAI: [Codex pricing](https://learn.chatgpt.com/docs/pricing), [GPT-OSS model and hardware overview](https://openai.com/index/introducing-gpt-oss/)
- Google: [Gemini CLI quotas and pricing](https://geminicli.com/docs/resources/quota-and-pricing/), [Google Developer Program plans](https://developers.google.com/program/plans-and-pricing), [Gemini ACP mode](https://geminicli.com/docs/cli/acp-mode/)
- GitHub: [Copilot plans](https://github.com/features/copilot/plans)
- Mistral: [plans and pricing](https://mistral.ai/pricing/), [Vibe surfaces and ACP](https://docs.mistral.ai/vibe/code/choose-cli-vscode-web-sessions), [programmatic CLI](https://docs.mistral.ai/vibe/code/cli/work-with-cli), [generic providers and billing behavior](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles)
- Kiro: [pricing](https://kiro.dev/pricing/), [ACP](https://kiro.dev/docs/cli/acp/)
- Groq: [free and developer rate limits](https://console.groq.com/docs/rate-limits)
- OpenRouter: [pricing](https://openrouter.ai/pricing), [free-model FAQ and limits](https://openrouter.ai/docs/faq)
- OpenCode: [Zen models, pricing, and privacy](https://dev.opencode.ai/docs/zen)
- Cursor: [pricing](https://cursor.com/pricing)
- Devin/Windsurf: [pricing](https://devin.ai/pricing), [plans and usage](https://docs.devin.ai/desktop/accounts/usage)

### Exclusions and comparison

- Anthropic: [individual Claude plans](https://support.claude.com/en/articles/11049762-choose-a-claude-plan), [Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- AWS: [Amazon Q Developer pricing](https://aws.amazon.com/q/developer/pricing/), [Amazon Q CLI maintenance status and Kiro successor](https://github.com/aws/amazon-q-developer-cli)
- Qwen: [authentication and discontinued OAuth free tier](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
- Amp: [original free program](https://ampcode.com/news/amp-free-frontier), [closed admission](https://ampcode.com/news/amp-free-is-full-for-now)
- Cerebras: [pricing and one-time free trial](https://www.cerebras.ai/pricing)
