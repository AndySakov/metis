# ADR-011: Effect as Runtime, Type System and Service Layer

Status: Accepted

## Context

Effect was adopted in the codebase without a decision record — despite ADR-004 establishing that specs are canonical and decisions are recorded. It is the single most defining commitment in the project: it shapes every service boundary, every error path and every type in the tree. Leaving it undocumented meant the largest architectural choice in METIS was the only one with no rationale attached.

Recording it now, after the fact, rather than pretending it was never decided.

## Decision

Effect is the runtime, the type system and the dependency-injection layer for METIS core.

- **Effect Schema** for all boundary types — API payloads, stored records, tool inputs and outputs. Schemas are the runtime validators and the compile-time types simultaneously; no separate validation layer.
- **`Context.Tag`** for every service. Services are interfaces first, implementations second, so any service can be replaced with a test double or a different backend without touching callers.
- **`Schema.TaggedError`** for all failure modes. Errors are values in the type signature. No exceptions across service boundaries.
- **Branded types** for identifiers and primitives that must not be interchangeable (`EventId`, `ArtifactId`, `EventTs`).
- **`@effect/platform`** for HTTP. `HttpApi` / `HttpApiGroup` / `HttpApiEndpoint` define the surface, and the OpenAPI spec is reconciled against it rather than hand-maintained in parallel.

## Rationale

Effect's error channel and dependency injection map directly onto what METIS actually needs. A system whose central claim is "constrained from move one" benefits from failure modes being visible in type signatures rather than discovered at runtime, and from services being swappable interfaces rather than concrete imports.

Schema doing double duty as validator and type removes an entire class of drift — the kind already present in this repo, where `specs/Intent.schema.json` and `src/ingress/IntentApi.ts` describe different shapes.

It also matches the maintainer's existing depth in functional effect systems (ZIO, Cats Effect), which materially affects velocity on a solo project.

## Alternatives considered

- **Plain TypeScript with Zod and manual DI.** Faster to onboard others, easier to read cold, and loses the effect-system guarantees the design leans on. Rejected: the guarantees are the point, and there are no others to onboard.
- **Spike both against the same vertical slice.** Honest, and expensive at a stage where the loop does not yet run. Rejected on cost.

## Consequences

- Steep ramp for any future contributor unfamiliar with Effect. Accepted; single-maintainer project.
- Effect's API surface moves. Version bumps will occasionally require migration work. Pin, and upgrade deliberately.
- The OpenAPI spec and the `HttpApi` definition can diverge. **One must generate or validate the other in CI** — this is now a required check, not a convention.
- Anything crossing the process boundary must have an Effect Schema. Non-negotiable; it is the mechanism that prevents spec/code drift.

## References

- ADR-004 API & Event Spec Canon
- `src/ingress/IntentApi.ts`, `src/mneme/*.ts`
