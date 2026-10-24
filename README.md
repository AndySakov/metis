# METIS

[![Check](https://github.com/AndySakov/metis/actions/workflows/check.yml/badge.svg)](https://github.com/AndySakov/metis/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Modular Engine for Thought, Insight, and Synthesis** — a personal, Jarvis-grade copilot that
takes an idea from spark → exploration → design → execution, remembers with provenance, learns a
voice, and earns autonomy rather than assuming it.

Named for the Greek _mētis_: cunning counsel, craft.

Single user. Not a product, not multi-tenant. Designed for one person operating it daily, with the
multi-user seams left open but not built.

---

## Current state — read this first

**The design runs well ahead of the implementation. This section is the honest inventory.**

What exists and works:

- Contract schemas in `specs/` — Intent, IntentDraft, Plan, Artifact, Event, ToolSpec, shared types,
  17 capability contracts, 17 example tool descriptors.
- Effect Schema domain types in `src/domain/` that decode those contracts, with branded identifiers
  and tagged errors.
- A PostgreSQL schema in `migrations/`, with domain constraints and a checksum-verifying migration
  runner (`pnpm migrate`).
- `EventLogStore` and `ArtifactStore`, each with **two adapters** — in-memory and PostgreSQL — that
  pass the same conformance vectors.
- A `PolicyEngine` that evaluates at three points and records **which rule matched, or explicitly
  none**, driven by policy vectors in `specs/policy/conformance/`.
- A `TrustLedger` with independent competence and compliance scores, explicit decay half-lives, and
  promotion that requires both, derived live from the event log. Every gear change is written back
  as an event: by the run that earned it, or, for a demotion earned by idleness, by an hourly sweep
  that `pnpm start` runs, so the log shows when a skill lost its gear rather than when it next ran.
- A **planner** — template-matched and deliberately dumb — that turns an Intent into a structurally
  valid Plan, targeting capabilities and never naming a tool implementation.
- **Steps that chain.** A tool call can bind part of its input to an earlier step's output
  (`ToolCall.bindings`, JSON Pointers on both sides), so "Summarize https://..." fetches the page
  and summarizes what it fetched. The value carries its labels: anything a `public.web` tool
  returns is `untrusted`, and policy sees that at every later step it reaches. A fetch steered by
  a fetched page is denied by `deny.untrusted_egress` in the running loop, not only in the red-team
  suite. A binding that could never resolve is rejected when the plan is decoded.
- A **`PolicyGate`** that evaluates and writes every decision to the event log, and a **coverage
  report** computing the unmatched fraction, dead rules and vacuous rules from that log.
- A **tool registry** resolving a capability id to an implementation, rejecting descriptors that
  break ADR-006's rules at construction rather than at dispatch.
- An **MCP client and a real MCP server** (`src/tools/servers/design.ts`) — `design.prd@1.0` is
  answered over stdio by a separate process, so the transport is genuinely exercised.
- An **executor** that walks a plan, evaluates policy at all three points, dispatches tools, gates
  on approval, and writes artifacts with a verified checksum and provenance.
- **Working HTTP handlers** behind the declared endpoints, served and tested over a real socket.
- **Trust derived from the event log** — competence and compliance computed from the same record an
  auditor would read, with a violation demoting immediately rather than being averaged away, and
  every gear change written back as `TRUST_PROMOTED` / `TRUST_DEMOTED` with its justification.
- **Durable plans.** `PostgresPlanStore` persists intents and plans in the normalised shape the
  schema describes, so a plan survives a restart with its step order and trust tags intact.
- **A red-team suite** (`specs/redteam/`) that reports a number: how many attempts got through, and
  of those stopped, how many were stopped **by a rule** rather than by luck.
- **Gear enforcement in the execution path.** The executor asks the trust ledger whether a skill has
  earned the gear the intent requested; an untrusted skill falls back to human oversight rather than
  running unattended, and the decision is recorded as `TRUST_GATE`.
- **Sampled verification** (ADR-014 §4) — a configurable fraction of executed actions is checked
  against the output schema its capability declares, independent of whether any rule flagged it.
- **Nine capabilities with real MCP implementations** across four servers: `design.prd`,
  `design.c4`, `design.api_spec`, `design.trade_study`, `transform.extract`, `research.fetch`,
  `research.summarize`, `research.claim_graph`, `build.scaffold`. `research.fetch` does real HTTP
  and refuses loopback, private and link-local hosts; `research.summarize` is extractive, so a
  citation always points at text that was genuinely supplied.
- **A project scaffolder that writes to disk.** `build.scaffold` (`src/tools/servers/build.ts`)
  creates a `node-ts` or `python` project under `METIS_WORKSPACE` and nowhere else: the name must
  be one safe path segment, and it never writes over an existing directory. It is declared
  non-idempotent, so policy asks a human before every run at every gear.
- **A model behind the design capabilities.** `metis.model` (`src/tools/servers/model.ts`) answers
  the four `design.*` capabilities with Claude, as a second implementation beside the
  deterministic templates in `metis.design`. The model gets no tools, so a call's only effect is
  the document it returns, and only this server receives `ANTHROPIC_API_KEY`: the runner hands each
  tool process its own environment. Without the key, every call is a tool error.

- **Durable execution on Restate** (ADR-016), reachable through the API. `POST /plans/{id}/execute`
  submits the plan and reports which path ran it: `restate` is durable — retries, checkpointing,
  real suspension on an approval gate — and `direct` runs in-process and is **not**. The mode is
  reported rather than hidden, so a caller cannot mistake one for the other. Tested against a real
  Restate server.

**The loop runs.** `test/orchestrator/Loop.test.ts` takes an intent to a stored artifact through a
real MCP subprocess, with the whole run correlated in the event log — and covers the paths that
matter: an approval that genuinely stops execution until granted, a policy denial that produces no
artifact, and an unresolvable capability that fails cleanly instead of dispatching something else.
- An HTTP surface of eight endpoints, reconciled against the OpenAPI document in CI, status codes
  included: the intent and plan endpoints, plus read-only `GET /tools`, `GET /trust` and
  `GET /eventlog` (filterable to one plan).
- **A console** at `/` (`src/ingress/console.html`). Type a goal and you see the plan, run it,
  approve what it stops for, and read what it wrote, with Mermaid diagrams rendered. Beside that
  are the plan's record (every policy decision and the rule behind it, trust gates, promotions) and
  each skill's gear and evidence, which move as you use it. It is a plain client of the API, and
  renders documents as text, since they can quote the open web.
- **A runnable entrypoint.** `pnpm start` (`src/App.ts`) serves the API over real implementations:
  the live policy in `specs/policy/default.json` (the same file the red-team suite measures), a
  registry holding only the tools their MCP servers actually serve, a planner that plans only
  those, and trust derived live from the event log, so autonomy earned while it runs takes effect
  at once. See "Running it" below.
- A test suite that fails when a spec and the code disagree.

What does **not** exist yet, despite being described in `docs/`:

- Eight of the seventeen capabilities remain descriptors: `research.search` (needs a search
  backend), `run.notebook`, `graph.link`, `vector.upsert`, and the four `agent.*` ones, which need real browser and device control. Implementing any of them against canned
  responses would be worse than leaving them out — the registry would claim a capability that does
  not do what its contract says.
- The monorepo layout, `examples/`, voice, device control, the Adaptive Agent Foundry.

---

## Tenets

- Always-visible plan — no hidden steps; diffs and cost/time budgets surfaced.
- Provenance everywhere — sources, claim links, artifact checksums.
- Gears for safety: S0 advise → S1 draft → S2 sandbox run → S3 gated run → S4 scheduled autonomy.
- Learning-first, with shadow evaluation and one-click revert.
- Local-first privacy — scoped connectors, redaction at ingest.
- Composability for years — stable capability contracts, SemVer, hot-swap.
- **Prove the constraints held, don't assert them.** Policy coverage is measured; trust splits into
  competence and compliance. This is the part with no equivalent in existing agent tooling.

---

## Architecture

Seven layers (ADR-000). Marked by what actually exists:

| Layer                     | Contents                                                        | State        |
| ------------------------- | --------------------------------------------------------------- | ------------ |
| Interface                 | realtime voice & chat, canvas, command palette                   | web console  |
| Orchestrator              | intent → plan → dispatch → memory writes                         | **built**    |
| Memory (`mneme`)          | event log, artifact store, external retrieval                    | **built**    |
| Knowledge Engine          | multi-corpus retrieval, claims/evidence, licensing               | not started  |
| Tooling/Execution         | MCP tools, notebook runner, CI hooks                             | MCP tools    |
| Governance/Safety         | capability gating, approvals, policy-as-code, audit              | **live**     |
| Observability             | traces, cost/latency budgets, eval dashboards                    | not started  |

Load-bearing decisions:

- **Effect** is the runtime, type system and DI layer (ADR-011).
- **PostgreSQL**, accessed directly, no ORM (ADR-018). Gel is discontinued and removed.
- **Restate** for durable execution — plans are workflows, not a hand-built DAG scheduler (ADR-016).
- **MCP** is the tool transport; capability IDs stay the semantic layer above it (ADR-017).
- **TypeScript** is the core; other languages only at contract boundaries, only with a measurement
  and an ADR (ADR-015).

**Tool isolation is process-level only.** MCP servers are separate processes; that is weaker than
the container-or-WASM story in ADR-003. A WASM component host is the intended destination and has
not been started. Treat any tool as trusted-by-configuration.

---

## Repository layout

```text
metis/
  migrations/        numbered plain-SQL migrations
  specs/             canonical contracts — code conforms to these, not the reverse
    common/          shared types (Identifier, Timestamp, Actor, Budget, Error, ...)
    capabilities/    per-capability input/output schemas
    tools/examples/  example ToolSpec descriptors
    storage/         conformance vectors
    api/             OpenAPI 3.1
    events/          AsyncAPI 2.6
  src/
    domain/          Effect Schema types — one home per type
    ingress/         HTTP surface
    mneme/           memory services and their adapters
    orchestrator/    planner and executor
    policy/          policy engine, gate, coverage, trust ledger
    tools/           registry, MCP client, and the MCP servers themselves
    db/              migration runner and column codecs
    config/          configuration
  test/specs/        the checks that keep specs and code from drifting apart
  test/storage/      conformance vectors run against every adapter
  test/policy/       policy and trust vectors
  docs/adrs/         decision records
  docs/planning/     rebuild plan, roadmap, limits
```

There is no `/apps`, `/packages` or `/infra`. Earlier drafts described a monorepo; it was never
built and the description has been removed rather than left standing.

---

## Contracts

- **Capability IDs**: `domain.action@MAJOR.MINOR`. The planner targets capabilities, never
  implementation names. MAJOR breaks; MINOR is additive; PATCH is invisible here.
- **Identifiers**: UUIDv7 — time-sortable. **UUIDv4 is forbidden**, and enforced: the Effect schema
  rejects it and the `uuid_v7` Postgres domain makes it unwritable.
- **Timestamps**: UNIX epoch seconds, integers, at every layer including storage (ADR-005, ADR-019).
- **Errors**: tagged errors; no thrown exceptions across service boundaries.
- **Every tool declares whether it is idempotent** — durable execution replays, and a replayed
  non-idempotent tool is a real-world side effect happening twice.

Full index: `docs/planning/metis_phase_0_artifacts.md`.

---

## Working on it

```bash
pnpm install
pnpm check     # typecheck
pnpm lint      # lint
pnpm test      # vitest
```

To apply the database schema:

```bash
POSTGRES_HOST=localhost POSTGRES_USER=you POSTGRES_PASSWORD=... \
POSTGRES_DATABASE=metis pnpm migrate
```

`pnpm migrate` is safe to re-run: applied migrations are skipped, and one whose file changed after
it was applied fails loudly rather than silently diverging.

## Running it

```bash
METIS_MODEL_CLI=claude pnpm start    # http://localhost:8787, METIS_PORT to change it
```

Open http://localhost:8787/ for the console. Try "Summarize https://en.wikipedia.org/wiki/Metis_(mythology)",
then a PRD or C4 diagrams, and approve the steps it asks about. Run the same kind of goal a few times
and watch that skill's gear climb until it stops asking.

- `METIS_MODEL_CLI` has a model CLI answer the `design.*` capabilities, on whatever login that CLI
  already has, so no API key is needed. Without a model configured, the templates answer.

  | `METIS_MODEL_CLI` | Runs                                            | Its own tools while answering           |
  | ----------------- | ----------------------------------------------- | --------------------------------------- |
  | `claude`          | `claude -p` (Claude Code login)                 | all switched off                        |
  | `codex`           | `codex exec`, read-only sandbox                 | shell stays on, read-only               |
  | `gemini`          | `gemini -p`                                     | read-only tools may run                 |
  | `ollama`          | `ollama run $METIS_MODEL_CLI_MODEL` (local)     | none                                    |
  | `llm`             | Simon Willison's `llm`                          | none                                    |
  | `["cmd", "arg"]`  | your own command: prompt on stdin, answer on stdout | unknown                             |

  `METIS_MODEL_CLI_MODEL` picks the model where the CLI takes one (`{model}` in a custom command).
  The CLI gets only its own credential variables (`METIS_MODEL_CLI_ENV=A,B` adds more) and runs in
  an empty temporary directory. Startup warns when the chosen CLI keeps tools of its own. Only the
  `claude` preset was run end to end while building this; the others follow their documentation.
- `ANTHROPIC_API_KEY` has Claude answer through the API instead (`metis.model`); a configured CLI
  is preferred when both are set.
- `POSTGRES_*` (as for `pnpm migrate`) stores everything in Postgres; without `POSTGRES_DATABASE`
  everything is in memory and a restart empties it.
- `RESTATE_INGRESS_URL` (and `RESTATE_ADMIN_URL`, default `http://127.0.0.1:9070`) runs plans as
  Restate workflows served from METIS's own process (port `METIS_RESTATE_PORT`, default 9080): a
  run parks on an approval and survives a restart. Pair it with Postgres, or the plans and record a
  resumed run needs are gone. Without it, plans run in-process (`mode: "direct"`), which is not
  durable. `node_modules/.bin/restate-server` is a Restate server to point it at.
- `METIS_WORKSPACE` lets `build.scaffold` create projects in that directory ("Scaffold a
  TypeScript project called notes-api"). Without it the server that writes to disk is not started.
- `GET /plans/{id}/execution` reports a plan's latest run from the event log, in either mode. A
  durable execute returns `accepted` before anything has run, so this is where its outcome, and the
  `artifactId` of what it wrote, is read.

```bash
curl -s -X POST localhost:8787/intent -H 'content-type: application/json' \
  -d '{"actor":"user:andysakov","goal":"Draft a PRD for an offline-first notes app","autonomy":"S2"}'
# -> a plan; then, naming the step to approve:
curl -s -X POST localhost:8787/plans/<plan id>/execute -H 'content-type: application/json' \
  -d '{"approvedSteps":["<step id>"]}'
# -> {"status":"completed","steps":[{"stepId":"...","status":"completed","artifactId":"<id>"}],...}
curl -s localhost:8787/artifacts/<artifact id>/content    # the document itself
```

A skill with no history is at S0, so every tool step asks for approval at first. Trust is derived
live from the event log, and a gear needs both a score and enough evidence behind it in each
ledger. An approved, completed run adds about two signals to each, so a skill runs unattended at
S2 after three such runs. S4 needs forty signals in each ledger, so at least twenty runs, and more
once runs stop needing approval, since an unattended run adds no approval signal.

Evidence fades: a signal counts half after one half-life (30 days for competence, 14 for
compliance), so a skill that stops running loses its gear, and recent behaviour outweighs old. Each
promotion or demotion is written to the log as `TRUST_PROMOTED` or `TRUST_DEMOTED`, with its
justification.

**Definition of done for any change:** typecheck passes, lint passes, tests pass, and any spec the
change touches is updated in the same commit.

`CLAUDE.md` carries the working context — locked decisions, open decisions, and the traps in this
repo. Read it before making changes.

---

## Learning & adaptation (designed, not built)

- Signals: explicit feedback, edit diffs, tool approvals, reuse, outcomes.
- Memory: persona profile, style kit, working habits, decision priors, trust ledger by domain.
- Autonomy ramp: per-skill trust drives S0→S4, decaying over time.
- **Trust is two ledgers, not one** (ADR-014). Competence rises on doing the job well; compliance
  rises only on safety evidence. Promotion requires both; a compliance event demotes immediately.
  Measuring only competence would ratchet a good writer toward scheduled autonomy on the strength
  of its prose.

---

## Safety posture

- Policy evaluated at three points: plan validation, tool dispatch, artifact write — and re-evaluated
  on workflow resume, never restored from a checkpoint.
- Every policy evaluation records **which rule matched, or explicitly none**. The unmatched fraction
  is the honest measure of how much behaviour is actually governed, and it will be uncomfortable at
  first (ADR-014).
- Two logs, two purposes: Restate's journal is disposable execution mechanics; the METIS event log
  is the tamper-evident audit record. Never merge them (ADR-016).

`docs/planning/Limits-and-Guardrails.md` lists what this can't do, including things that are flatly
impossible. It is deliberately unflattering; keep it that way.

---

## Roadmap

`docs/planning/REBUILD-PLAN.md` is authoritative. Stage 0 (fix the drift) is complete; Stage 1 is
the four services with implementations and tests.

`docs/planning/metis_v_1_roadmap.md` is the original ten-phase plan, retained for the capability
detail in it. Where it conflicts with the rebuild plan — particularly on the monorepo, the DAG
scheduler and container-packaged tools — the rebuild plan and the ADRs win.

Success is not "how many phases are done". It is two questions:

1. Can it complete a real task end to end, with provenance, without hand-holding?
2. Can it **prove** the constraints held while doing so — from the event log, with a coverage number
   and a red-team pass rate?

---

## Glossary

- **ADR** — Architecture Decision Record; one decision per document.
- **CAP ID** — Capability ID, `domain.action@MAJOR.MINOR`.
- **Gears** — autonomy levels S0–S4.
- **Persona Pack** — style kit + tool policy + questioning rules + trust ledger.
- **`mneme`** — the memory layer in code (Mnemosyne). Older docs say "Memory Fabric".

---

## License

MIT. See `LICENSE`.
