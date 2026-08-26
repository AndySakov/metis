# METIS — Working Context

Read this before touching anything. It records what METIS is, what has actually been decided, and the traps in this repo.

## What METIS is

A personal Jarvis-grade copilot: idea → exploration → design → execution, with memory that carries provenance, a style that adapts to its user, and autonomy that ratchets up only as trust is earned. Named for the Greek *mētis* — cunning counsel, craft.

Single user (Teminife / Andy). Not a product, not multi-tenant. Design for one person operating it daily, with the multi-user seams left open but not built.

## Current state — read this honestly

**Stages 0 through 4 are done. The loop runs end to end and survives a crash — intent to stored artifact over real MCP, policy live at all three points, plan execution as a Restate workflow with real suspension, and trust written back from the event log.**

What exists in code: contract schemas in `specs/`, Effect Schema domain types in `src/domain/` (one home per type), a PostgreSQL schema in `migrations/` with domain constraints, a checksum-verifying migration runner, `EventLogStore` and `ArtifactStore` with in-memory *and* Postgres adapters passing the same conformance vectors, a `PolicyEngine` whose every decision records the matched rule or an explicit `unmatched`, a read-only two-ledger `TrustLedger`, a template-matched planner, a `PolicyGate` that writes every decision to the event log, an ADR-014 coverage report computed back out of that log, a tool registry, an MCP client with a real stdio server behind `design.prd@1.0`, an executor that runs a plan with policy at all three points and writes checksummed artifacts with provenance, working HTTP handlers, a Postgres `PlanStore` so plans survive restarts, trust derived from the event log with gear changes written back as events, a red-team suite reporting caught-by-rule versus caught-by-luck, gear enforcement and sampled verification in the execution path, eight capabilities with real MCP implementations across three servers, an HTTP surface declaring three endpoints, and a test suite that fails when a spec and the code disagree.

What does not exist: nothing in the core loop. `POST /plans/{id}/execute` submits to Restate when the durable layer is provided and reports its mode either way. Nine of the seventeen capabilities are still descriptors — `research.search` needs a search backend, and the `agent.*` ones need real browser and device control. Do not implement any of them against canned responses: a registry entry that does not do what its contract says is worse than an absent one, because the planner will target it. The monorepo layout, `examples/`, voice and device control are also absent and are no longer described as present.

The README now matches the tree — it has a "Current state" section that says what is and is not built. Keep it that way: if a change makes a README claim false, fix the README in the same commit.

## Locked decisions

Settled. Do not relitigate without an ADR superseding them.

- **Effect is the runtime and the type system** — Effect Schema for all boundary types, `Context.Tag` for services, tagged errors everywhere (ADR-011).
- **PostgreSQL, accessed directly** via `@effect/sql-pg`, no ORM. Plain numbered SQL migrations. Gel is discontinued and removed (ADR-018, superseding ADR-012). The migration runner is the one deliberate exception and uses `pg` directly; store adapters are not exempt.
- **TypeScript is the core; other languages only at contract boundaries, only with a measurement, only with an ADR** (ADR-015). The orchestrator, planner, policy engine, trust ledger and memory layer are not rewrite candidates.
- **Restate for durable execution.** Long-running plans are Restate workflows. Do not hand-build a DAG scheduler (ADR-016).
- **MCP is the tool transport; capability IDs stay the semantic layer above it** (ADR-017). The planner targets CAP IDs and never names an MCP server.
- **Rework in place.** Same repo, same history. Restructure inside it.
- **Contract-first.** Specs in `specs/` are canonical; code conforms to specs, not the reverse (ADR-004). If code and spec disagree, one is a bug — decide which, fix it, never let both stand.
- **Policy is in the execution path from the first slice**, not deferred to Phase 7.
- **Policy efficacy is first-class** — coverage is measured, trust splits into competence and compliance (ADR-014).

## Open decisions

- WASM component host for real tool sandboxing. Intended destination, not yet started. Until then tool isolation is process-level only — say so plainly rather than implying otherwise.
- Graph store: currently absent (ADR-013). Revisit only if a genuine deep-traversal workload appears.
- ~~Timestamp representation in storage.~~ **Closed by ADR-019:** epoch seconds as `bigint` at every layer, no `timestamptz`.

## Conventions

- **Timestamps:** UNIX epoch seconds, integers, everywhere including storage (ADR-005, ADR-019). `ts` on records of a moment (Event, Intent); `createdAt`/`updatedAt` on entities that persist.
- **IDs:** UUIDv7. **UUIDv4 is forbidden** and now unrepresentable — the Effect schema rejects it and the `uuid_v7` Postgres domain refuses to store it.
- **Capability IDs:** `domain.action@MAJOR.MINOR`. The planner targets capabilities, never implementation names.
- **Errors:** tagged errors via `Schema.TaggedError`. No thrown exceptions across service boundaries.
- **Every service is a `Context.Tag` with an interface**, so it can be swapped for a test double without ceremony.
- **Database constraints belong in the schema**, not only in application code. Domain types with CHECK constraints, native enums. Invalid state should be unrepresentable at both the process edge and the storage edge.
- **Every tool declares whether it is idempotent.** Durable execution replays; a non-idempotent tool that gets replayed is a real-world side effect happening twice (ADR-016).
- **Naming:** the memory layer is `mneme` in code (Mnemosyne). Docs say "Memory Fabric." Prefer `mneme` in code and fix the docs, not the other way round.

## Known drift — closed

The eleven divergences found by the original audit are fixed. Recorded here because the *shape* of
the failure matters more than the individual bugs: every one of them was a second source of truth
that nothing checked.

1. ✅ Gel schema ported to Postgres — `migrations/0001_initial.sql`, constraints preserved as domains.
2. ✅ UUIDv7 replaces `uuid_generate_v4()`, and is **enforced** by the `uuid_v7` domain, not just defaulted.
3. ✅ Epoch integers, decided and recorded in ADR-019.
4. ✅ `Intent` reconciled; the request/record split is `IntentDraft` vs `Intent`.
5. ✅ Numeric ids replaced with branded UUIDv7 throughout.
6. ✅ One `Artifact` (persisted metadata). What a plan intends to produce is `ArtifactExpectation`.
7. ✅ `ToolSpec` reworked for MCP binding, required `idempotent`, honest `isolation`.
8. ✅ ADR-001 marked partially superseded; ADR-007 corrected to two storage roles.
9. ✅ `metis_phase_0_artifacts.md` reduced to pointers.
10. ✅ README rewritten against the tree; roadmap marked historical, monorepo marked NOT BUILT.
11. ✅ Gel files, `GraphStore.ts` and `MemoryFabric.ts` deleted.

**What keeps them closed:** `test/specs/` fails the build when a spec and the code disagree — spec
examples are decoded with the real schemas, every identifier in every spec is checked for v7, all
`$ref`s must resolve, and the OpenAPI document is reconciled against the `HttpApi` definition
(ADR-011's required check). Adding a contract without adding it to these tests re-opens the door.

## Next — reach, then isolation

The loop runs, survives a crash, and writes its own trust back. Durability landed in
`PlanWorkflow.ts`; the trust writers landed in `TrustUpdater.ts`; the adversarial suite exists and
reports a number. What is thin now is how much of the world it can touch, and how well it is
contained while touching it.

1. **The nine descriptor-only capabilities.** `research.search` needs a real search backend; the
   `agent.*` ones need real browser and device control. Implement them against real backends or not
   at all — a registry entry that does not do what its contract says is worse than an absent one,
   because the planner will target it.
2. **The red team's one escape.** The suite reports seven attempts, six caught by rule, none caught
   by luck — and one through: an unknown capability at the highest gear. That is a rule gap, and it
   is the most concrete safety finding in the repo.
3. **Tool sandboxing.** Isolation is still process-level only. The WASM component host is the
   intended destination and has not been started.

## Traps

- **Do not let the drift re-open.** It is closed and held closed by tests. A new contract that is not covered by `test/specs/` is a new second source of truth waiting to diverge.
- **Do not write another planning document.** This project's failure mode is design-ahead-of-code. The ratio has since inverted — source, tests and contracts outweigh prose by roughly five to one — but the pull is still there. When in doubt, write code or a test, not a doc — and specifically, do not design the policy engine's schemas before writing the engine.
- **Do not let policy become a config file with no tests.** It now has vectors in `specs/policy/conformance/` covering effects, the fail-safe tie-break, and the unmatched case. Every new rule form needs a case; a rule shape with no vector is untested safety code.
- **Do not measure trust by task success alone** (ADR-014). Trust that rises because the user accepted the output is trust in usefulness, not safety.
- **Do not reach for Rust because it sounds good.** ADR-015 requires a measurement first. The device daemon will earn it; the orchestrator will not.
- **Do not put METIS's audit log inside Restate's journal.** They are different things — Restate's journal is execution mechanics and disposable; the event log is the tamper-evident record the safety story rests on (ADR-016).

## Verification

- `pnpm check` — typecheck
- `pnpm lint` — lint
- `pnpm test` — vitest
- `pnpm migrate` — apply the database schema (safe to re-run; fails if an applied migration was edited).
- Storage adapters must pass the conformance vectors in `specs/storage/conformance/` (`eventlog/`, `artifact/`). Both the in-memory and Postgres adapters run them; the Postgres suite skips when no database is reachable, unless `METIS_TEST_POSTGRES=1` makes that a failure.
- Policy rules must pass their vectors in `specs/policy/conformance/`. Every new rule form needs a case.

Definition of done for any change: typecheck passes, lint passes, tests pass, and any spec the change touches is updated in the same commit.
