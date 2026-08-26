# METIS Rebuild Plan

**Written:** August 2026, after a full audit of the repo against its own specs.
**Approach:** rework in place. Same repo, same history, restructured from the inside.

---

## 1. Why a rebuild

Nothing is wrong with the thinking. The problem is arithmetic: roughly 90KB of design documents against 8KB of source, and the two have drifted far enough apart that the README describes a system that does not exist.

The design work was not wasted — the gears, the capability contracts, the Limits doc and the graduation loop are all keepers. What has to change is the order of operations. Design has been running about nine months ahead of implementation, and every additional planning document widens the gap rather than closing it.

**The rule for this phase: no new planning documents.** Every unit of work from here produces code, a test, or a corrected spec.

---

## 2. What survives, unchanged

- **Autonomy gears S0–S4.** Clean, well-scoped, correct granularity.
- **Policy evaluated at three points** — plan validation, tool dispatch, artifact write. Enforcement belongs at the seams, not in one chokepoint.
- **Capability contracts.** `domain.action@MAJOR.MINOR`, planner targets capabilities not implementations. This is what makes hot-swap, versioning and the graduation loop coherent — and it is what lets the transport underneath be swapped for MCP without touching the planner.
- **The Limits & Guardrails doc.** Unusually honest, including a list of things that are flatly impossible. Keep it, keep updating it.
- **The Agent → Tool graduation loop.** Now produces an MCP server, which is useful outside METIS too.
- **Conformance vectors for storage adapters.** Correct instinct, wrong scope — extend to policy.
- **Effect, branded types, tagged errors.** Right choice for a system where correctness matters.
- **The domain constraints in the Gel schema.** The types survive the move to Postgres even though Gel does not.

---

## 3. What changes

### 3.1 Three things get adopted instead of built

- **Durable execution → Restate** (ADR-016). Phase 6a shrinks from "build a durable DAG scheduler" to "model plans as workflows." Probably a three-to-six-month saving on the hardest infrastructure item in the roadmap.
- **Tool transport → MCP** (ADR-017). CAP IDs stay as the semantic layer. Inherits an ecosystem instead of maintaining a bespoke protocol.
- **Datastore → bare Postgres** (ADR-018). Gel is discontinued; the escape hatch ADR-012 anticipated is now the path.

### 3.2 Language stays TypeScript, with deliberate exits

ADR-015: TypeScript and Effect are the core. Other languages only at contract boundaries, only after a measurement, only with an ADR. The device daemon will earn Rust; the orchestrator never will, because it spends its life waiting on model inference.

### 3.3 Policy moves to the front

Originally Phase 7, now part of the first working slice. A policy engine bolted on at Phase 7 will be shaped by whatever the execution path grew into by then, and every seam it needs will have to be retrofitted.

### 3.4 Trust stops measuring the wrong thing

Current design promotes trust on low edit ratio and high task success — on METIS being *useful*. Nothing measures whether its constraints hold. Split into two ledgers that move independently:

- **Competence** — task success, edit ratio, acceptance.
- **Compliance** — policy evaluations survived, gates cleared without override, verified-clean sample rate.

Promotion requires both. Demotion on a compliance event is immediate. See ADR-014.

### 3.5 Coverage becomes a measured quantity

Nothing currently answers: did the policy have an opinion about what just happened? Record, per evaluation, whether a rule matched — and report the fraction that matched nothing. That unmatched fraction is the honest measure of how much behavior is actually governed. It will be embarrassing at first. That is the point.

Also track dead rules (never fired) and vacuous rules (fire on everything). Both are bugs.

### 3.6 Docs shrink

`metis_phase_0_artifacts.md` duplicates four ADRs and the full OpenAPI spec inline. Delete the duplication. Gut the README back to what is true. Build the monorepo layout or delete the description of it.

---

## 4. Work order

### Stage 0 — Stop the bleeding ✅ COMPLETE

Fix drift before building on top of it. Full inventory in `CLAUDE.md`.

All eleven items are closed and the exit criteria are met: `pnpm check`, `pnpm lint` and `pnpm test`
are green, the Postgres schema applies from `migrations/0001_initial.sql`, and the docs no longer
claim things that are not true.

Two things worth carrying forward. First, `pnpm lint` did not run at all when this stage started —
an invalid dprint option meant the documented verification command errored out, so "lint passes"
had never been true. Second, the drift is now held closed by tests rather than by vigilance:
`test/specs/` decodes every spec example with the real schemas, checks every identifier for v7,
resolves every `$ref`, and reconciles the OpenAPI document against the `HttpApi` definition. Each
check was mutation-tested to confirm it actually fails when the thing it guards is broken.

1. **Port the schema to Postgres.** Domain types with CHECK constraints for `NonEmptyString`, `Url`, `ShortString`, `LongString`; native enums for `Autonomy`, `Actor`, `ArtifactKind`, `PlanStepKind`; foreign keys and join tables for the links. Wire up `@effect/sql-pg`. Plain numbered SQL migrations.
2. Fold in the ADR-005 fixes during the port: UUIDv7 instead of v4, and a decision on epoch integers vs `timestamptz`.
3. Collapse the two `Artifact` definitions into one.
4. Reconcile `Intent` and `Plan` between `specs/` and `src/ingress/IntentApi.ts`.
5. Replace numeric ids on Plan/PlanStep/Assumption/Risk with sortable ids.
6. Rework `ToolSpec.schema.json` for MCP binding plus an idempotency declaration.
7. Delete: `gel.toml`, `dbschema/*.gel`, the Gel migrations, the commented-out `GraphStore.ts` and `MemoryFabric.ts`.
8. Gut the README. De-duplicate `metis_phase_0_artifacts.md`.
9. Review and accept ADR-011 through ADR-018.

**Exit:** `pnpm check && pnpm lint && pnpm test` green, Postgres schema applied from migrations, and no statement in the docs is false.

### Stage 1 — Skeleton with a spine ✅ COMPLETE

Four services as Effect layers. All four have interfaces, implementations and tests; no HTTP yet,
as specified.

Notes worth carrying forward. The storage vectors are **executed** now, by a runner that drives the
JSON files in `specs/storage/conformance/` against any adapter — so the in-memory and Postgres
implementations are held to the identical contract rather than to two hand-written test suites.
That immediately earned its keep: it caught the Postgres adapter returning `bigint` timestamps as
strings, which typechecked fine and would have surfaced as corrupt ordering in production.

Mutation testing found a gap the functional tests missed: the policy tie-break could be inverted to
fail *open* with every test still green. `specs/policy/conformance/ordering.json` now pins it.

- `EventLogStore` — Postgres-backed, append-only, idempotent by id, ordered by ts. Passes its conformance vectors.
- `ArtifactStore` — checksummed, versioned. Passes its vectors.
- `PolicyEngine` — new. Evaluates at the three points. Returns allow / deny / requires-approval **plus which rule matched, or explicitly none**. That field is not optional.
- `TrustLedger` — new. Two scores per skill, competence and compliance. Read-only at this stage.

**Exit:** all four have interfaces, implementations and tests. No HTTP yet.

### Stage 2 — The loop ✅ COMPLETE

Intent in, artifact out, policy live, running on Restate.

**Done:** items 1, 3, 4, 5 and 6. An intent becomes a plan, the plan executes, `design.prd@1.0` is
answered over MCP by a separate process, policy is evaluated at all three points with every
evaluation written to the event log, an approval genuinely stops execution until granted, and the
artifact is stored with a verified checksum and provenance back to both the plan and the intent.
Coverage reporting was pulled forward from Stage 3 because the gate made it nearly free.

**Item 2 — Restate — is now done too.** `src/orchestrator/PlanWorkflow.ts` models plan execution as
a workflow, and `test/orchestrator/Restate.test.ts` runs it against a **real Restate server**: a
gated step suspends via `ctx.promise`, and the workflow resumes when the approval is signalled from
outside.

Keeping the executor free of durability machinery paid off exactly as hoped — wiring Restate was a
substitution, not a rewrite, because there was no hand-rolled retry or checkpoint logic to unpick.

The property ADR-016 cares most about is now enforced by a test rather than by intent: execution is
**re-run on resume**, not restored from a checkpoint, so policy is evaluated afresh against current
state. The test counts executions to prove it, and inverting that behaviour fails the suite.

Two operational notes worth keeping. The server must be given `RESTATE_ADVERTISED_ADDRESS` pointing
at loopback — otherwise it advertises whatever the hostname resolves to, which on a machine with a
VPN interface is an address it cannot reach, and it hangs forever trying to join its own cluster.
And `endpoint().listen()` resolves to the bound port, not a closable handle.

`POST /plans/{id}/execute` now submits through `PlanExecution`, which has two implementations —
`restate` (durable) and `direct` (in-process, not durable). The submission reports which one ran,
because a caller that cannot tell them apart cannot know whether its plan survives a restart, and
silently degrading to the non-durable path would be the worst of both.

1. `POST /intent` → a Plan. The planner can be dumb — template-matched, three steps, hardcoded. It needs to produce a *valid* Plan, not a smart one.
2. Plan execution is a **Restate workflow**. Retries, checkpointing and suspension come from Restate, not from hand-written code.
3. One real tool, reached over **MCP**. `research.fetch` or `design.prd`, whichever is less work.
4. **Policy evaluated at all three points**, every evaluation written to the METIS event log with the matched-rule field. Policy is re-evaluated on workflow resume, never restored from a checkpoint.
5. One step requires approval, and execution genuinely suspends until granted.
6. Artifact written with checksum and provenance.

**Exit:** the golden demo runs. A PRD request produces a stored artifact; the event log shows three policy evaluations per step; the approval gate suspends the workflow and resumes it correctly; killing the process mid-plan and restarting resumes rather than restarts. Every claim in the README's demo section is now true.

### Stage 3 — Coverage and the registry

1. Tool registry: resolve CAP ID → MCP server and tool, validate the descriptor, run declared conformance vectors, reject invalid specs.
2. Second and third tools, so capability-targeting is exercised rather than theoretical.
3. **Policy coverage report** — unmatched fraction, dead rules, vacuous rules.
4. **Policy conformance vectors** — what ADR-008 asked for and nobody wrote. Every rule gets inputs and expected decisions.

**Exit:** three tools registered, an invalid descriptor rejected with a useful error, and a coverage number on screen.

### Stage 4 — Trust that means something 🟡 PARTIAL

Derivation is done: `src/policy/TrustUpdater.ts` computes both ledgers from the event log rather
than accumulating them in place, so a score cannot drift from the evidence for it. Competence rises
on completed work and falls on failure; compliance rises only on clean policy evaluations and drops
to a floor on any denial — immediate, not averaged, per ADR-014.

Not done: decay half-lives are enforced by `TrustLedger` but the derived record is computed at
`now`, so the two are not yet composed; promotion and demotion do not emit
`TRUST_PROMOTED`/`TRUST_DEMOTED` events; and the gear is not yet consulted in the execution path.

Original scope below.



1. Compliance ledger updates from real policy evaluations.
2. Competence ledger updates from approvals and edit ratios.
3. Decay with explicit half-lives in policy, not "decays over time."
4. Promotion requires both ledgers above threshold; a compliance event demotes immediately.
5. Gear enforcement in the execution path, tested rather than asserted.

**Exit:** a skill can be promoted and demoted, with the demotion path covered by a test that deliberately trips a rule.

### Stage 5 — Adversarial 🟡 PARTIAL

The suite exists: `specs/redteam/attempts.json` plus `test/redteam/`, running in CI with the rest.
It reports attempts, got-through, caught-by-rule and caught-by-luck as separate numbers — the last
split being the one that matters, since an attempt that merely failed to be allowed is not evidence
that anything worked.

Current reading: 7 attempts, 1 through (a documented gap, asserted *as* a gap so closing it is a
visible decision), 6 caught by rule, 0 by luck.

Not done: prompt injection through genuinely fetched content (needs a research tool that really
fetches), and the non-idempotent-replay case (needs Restate). Both are attempts against machinery
that does not exist yet, and writing them now would test the mock rather than the system.

Original scope below.



The first honest test of whether any of this works.

Red-team suite attempting things policy forbids: prompt injection through fetched content, an approval-gated action running without approval, a tool requesting undeclared scopes, a takedown that should cascade and doesn't, a non-idempotent tool replayed by Restate.

The output is a number: how many attempts got through, and how many were caught by a rule versus caught by luck.

**Exit:** the suite runs in CI and the pass rate is recorded rather than assumed.

---

## 5. What is explicitly not being built yet

Voice, AR/VR, mobile clients, device control, the Adaptive Agent Foundry, LoRA adapters and bandit policies, the monorepo split, a WASM component host, connectors beyond the first, and Web Memory.

All good ideas. None matter until the core loop runs with policy live and there is evidence the constraints hold. Revisit after Stage 5.

Note the honest gap in the meantime: **with MCP servers as processes, tool isolation is process-level only.** That is weaker than the container-or-WASM story in ADR-003. Record it in the Limits doc rather than implying stronger isolation than exists.

---

## 6. The measure of success

Not "how many phases are done." Two questions:

1. **Can it complete a real task end to end?** Intent to stored artifact, with provenance, without hand-holding.
2. **Can it prove the constraints held while doing so?** Not assert — prove, from the event log, with a coverage number and a red-team pass rate.

The second question is the one nobody else building agent infrastructure can answer. That is where the interesting work is.
