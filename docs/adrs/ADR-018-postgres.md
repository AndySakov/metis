# ADR-018: Datastore — Bare-Metal PostgreSQL

Status: Accepted
Supersedes: ADR-012 (Datastore Selection — Gel)

## Context

ADR-012 recorded Gel as the primary datastore, while explicitly flagging vendor maturity — not performance — as the real risk, and noting that Postgres underneath was the escape hatch.

That risk has materialised: Gel is being discontinued. The escape hatch is now the path.

This is a smaller change than it appears. Gel runs on Postgres, `pg` is already a dependency, and no application code depends on EdgeQL yet — the entire Gel surface in the repo is `dbschema/default.gel`, `gel.toml`, and a migrations directory.

## Decision

**PostgreSQL, accessed directly.** No ORM, no query-builder abstraction over the top.

- **Access layer: `@effect/sql` with `@effect/sql-pg`.** Keeps database access inside the Effect runtime (ADR-011), with rows validated by Effect Schema at the boundary — the same mechanism that prevents drift everywhere else in the system. SQL stays SQL; the wrapper provides resource management, typed errors and schema-validated results, not an abstraction layer.
- **Migrations: numbered plain-SQL files with a simple runner.** No migration DSL. A system intended to run for years wants migrations that are readable in ten years without a tool that may not exist then.
- **Domain constraints live in the schema, not only in application code.** This was the main reason Gel was attractive and it must be preserved on the way out.

## Preserving what Gel gave us

The existing `dbschema/default.gel` carries real value: a `trimmed` constraint, `NonEmptyString`, a regex-validated `Url`, length-bounded string types, and enums for `Autonomy`, `Actor`, `ArtifactKind` and `PlanStepKind`. All of it ports.

- Gel scalar types with constraints → **Postgres `DOMAIN` types with `CHECK` constraints**. `NonEmptyString`, `Url`, `ShortString`, `LongString` all express directly.
- Gel enums → **native Postgres `ENUM` types**.
- Gel's `Timestamped` abstract type → a shared column pair plus a trigger for `updated_at`.
- Gel links → foreign keys, and join tables for the multi-links (`Artifact.in_project`, `Plan.steps`, `Plan.artifacts`).

The property worth protecting is that invalid state is unrepresentable at *both* boundaries — Effect Schema at the process edge, database constraints at the storage edge. Do not port the tables and drop the constraints.

## Fold the outstanding drift into the port

Two known ADR-005 violations in the Gel schema are fixed as part of this work rather than tracked separately:

- `uuid_generate_v4()` on every primary key → **UUIDv7** (Postgres 18 has `uuidv7()` natively; on earlier versions use an extension or generate application-side). ADR-005 requires time-sortable identifiers and gives sortability as the reason; v4 defeats it.
- `datetime` columns → **epoch-second integers**, or amend ADR-005 to permit `timestamptz` in storage with integers at the API boundary. Decide during the port and record the choice.

## Outcome of the port

The port landed in `migrations/0001_initial.sql`. Three notes on how it differs from what this ADR
anticipated:

- **The timestamp question is settled by ADR-019:** epoch seconds as `bigint` at every layer, no
  `timestamptz`. ADR-005 is unchanged.
- **UUIDv7 is enforced, not merely defaulted.** A `uuid_v7` domain constrains the version and
  variant nibbles, so a v4 identifier cannot be written to this database at all. The `uuidv7()`
  function is a shim for PostgreSQL below 18 and can be dropped once the built-in exists, without
  touching the column defaults.
- **`Actor` is a domain, not a native enum,** contrary to the list above. The qualified
  `user:andysakov` form keeps the multi-user seam open and an enum cannot express it; a `CHECK`
  against the same regex the wire format uses does. `Autonomy`, `ArtifactKind` and `PlanStepKind`
  are native enums as planned.
- **The migration runner uses `pg` directly, not `@effect/sql-pg`.** This is a deliberate, narrow
  exception to the access-layer decision above. The runner executes DDL before the application
  exists and its whole value is being simple enough to read in ten years; `@effect/sql-pg` also
  ships its own migrator, and adopting it would reintroduce the migration DSL this ADR rejects.
  **Store adapters are not covered by this exception** — when they land in Stage 1 they go through
  `@effect/sql` with rows validated by Effect Schema at the boundary, which is the whole point.

## Consequences

- **Lose EdgeQL's traversal ergonomics.** Provenance relationships become joins. ADR-013 already established that these traversals are one or two hops deep, so this is a readability cost, not a capability loss. Revisit only if a genuine deep-traversal workload appears.
- Lose Gel's migration tooling. Plain SQL migrations are more verbose and entirely portable.
- Gain the largest ecosystem in the database world, and remove a single-vendor dependency from the foundation of a decade-long project. This is the point.
- **Note for ADR-016:** DBOS is now a marginally stronger fallback for durable execution, being Postgres-native. Restate stands as the decision; this is recorded only so the reasoning is available if Restate is ever revisited.
- Delete `gel.toml`, `dbschema/*.gel` and `dbschema/migrations/` once the port lands. Do not leave them as dead reference.

## References

- ADR-005 Identifiers & Timestamps
- ADR-011 Effect Runtime
- ADR-012 Datastore Selection — Gel (superseded)
- ADR-013 Memory Model Revision
- `dbschema/default.gel` (to be ported and removed)
