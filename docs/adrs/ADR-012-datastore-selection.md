# ADR-012: Datastore Selection — Gel

Status: Superseded by ADR-018

## Context

The v1 roadmap deliberately left datastores TBD, with a stated selection gate after Phase 3: draft options, score them, spike the top two, then lock the choice with an ADR and a migration plan.

That gate was never run. Gel was adopted anyway — `gel.toml`, `dbschema/default.gel` with real domain types, and `pg` in the dependency list. The decision is already load-bearing.

This ADR records what happened, evaluates whether it was right, and closes the gate retroactively rather than leaving the project's second-largest commitment undocumented.

## Decision

Gel is the primary datastore for METIS core.

It backs the relational and timeline concerns: projects, intents, plans, plan steps, artifact metadata, events, policy evaluations and trust ledger state.

## Rationale

Gel's schema language expresses domain constraints declaratively — the existing `dbschema/default.gel` already carries a `trimmed` constraint, `NonEmptyString`, `Url` with pattern validation, length-bounded string types, and enums for `Autonomy`, `Actor` and `PlanStepKind`. Those constraints live at the storage layer rather than only in application code, which means bad data cannot be written even by a buggy caller.

That property complements ADR-011 directly: Effect Schema validates at the process boundary, Gel validates at the storage boundary, and the two together mean invalid state is unrepresentable at both ends.

Its link-based model also handles the provenance relationships in ADR-001 — artifact derives-from source, decision justified-by claim — without a separate graph database, which is the substance of ADR-013.

## Alternatives considered

- **PostgreSQL directly.** Fewer unknowns, larger ecosystem, no schema-level domain constraints without hand-written CHECKs and triggers. Viable fallback if Gel becomes a liability; Gel runs on Postgres, so the escape hatch is real.
- **Neo4j plus Postgres**, per the original two-store design. Rejected: operational overhead of two stores for a single-user system, and no traversal workload yet exists to justify it. See ADR-013.

## Consequences

- Smaller ecosystem than Postgres. Fewer answers when something goes wrong.
- Migration tooling is Gel-specific. `dbschema/migrations/` is the source of truth for schema evolution.
- **The current schema violates ADR-005.** It uses `uuid_generate_v4()` for every primary key, where ADR-005 requires time-sortable identifiers (ULID or UUIDv7) and gives sortability as the explicit reason. It also uses `datetime` where ADR-005 specifies epoch-second integers. Both must be fixed before further schema work; see the rebuild plan, Stage 0.
- Escape hatch retained: if Gel proves limiting, the underlying Postgres model is recoverable. Do not build on Gel-only features without noting the cost.

## References

- ADR-005 Identifiers & Timestamps
- ADR-013 Memory Model Revision
- `dbschema/default.gel`, `gel.toml`
