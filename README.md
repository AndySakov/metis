# METIS

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
  promotion that requires both. Read-only at this stage.
- A **planner** — template-matched and deliberately dumb — that turns an Intent into a structurally
  valid Plan, targeting capabilities and never naming a tool implementation.
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
- **Eight capabilities with real MCP implementations** across three servers: `design.prd`,
  `design.c4`, `design.api_spec`, `design.trade_study`, `transform.extract`, `research.fetch`,
  `research.summarize`, `research.claim_graph`. `research.fetch` does real HTTP and refuses
  loopback, private and link-local hosts; `research.summarize` is extractive, so a citation always
  points at text that was genuinely supplied.

- **Durable execution on Restate** (ADR-016), reachable through the API. `POST /plans/{id}/execute`
  submits the plan and reports which path ran it: `restate` is durable — retries, checkpointing,
  real suspension on an approval gate — and `direct` runs in-process and is **not**. The mode is
  reported rather than hidden, so a caller cannot mistake one for the other. Tested against a real
  Restate server.

**The loop runs.** `test/orchestrator/Loop.test.ts` takes an intent to a stored artifact through a
real MCP subprocess, with the whole run correlated in the event log — and covers the paths that
matter: an approval that genuinely stops execution until granted, a policy denial that produces no
artifact, and an unresolvable capability that fails cleanly instead of dispatching something else.
- An HTTP surface declaration for three endpoints, reconciled against the OpenAPI document in CI.
- A test suite that fails when a spec and the code disagree.

What does **not** exist yet, despite being described in `docs/`:

- Nine of the seventeen capabilities remain descriptors: `research.search` (needs a search
  backend), `build.scaffold`, `run.notebook`, `graph.link`, `vector.upsert`, and the four `agent.*`
  ones, which need real browser and device control. Implementing any of them against canned
  responses would be worse than leaving them out — the registry would claim a capability that does
  not do what its contract says.
- The monorepo layout, `examples/`, voice, device control, the Adaptive Agent Foundry.
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
| Interface                 | realtime voice & chat, canvas, command palette                   | not started  |
| Orchestrator              | intent → plan → dispatch → memory writes                         | **built**    |
| Memory (`mneme`)          | event log, artifact store, external retrieval                    | **built**    |
| Knowledge Engine          | multi-corpus retrieval, claims/evidence, licensing               | not started  |
| Tooling/Execution         | MCP tools, notebook runner, CI hooks                             | 1 real tool  |
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
