# METIS Phase 0 — Artifacts (index)

This document used to carry ADR-000 through ADR-003, the JSON Schemas, the full OpenAPI document
and the AsyncAPI channels **inline**, as copies. That made it a second source of truth for every
one of them, and the copies had drifted: the inlined ADRs still described a three-tier memory model
that ADR-013 replaced, and the inlined OpenAPI still described request shapes that no longer exist.

The duplication is gone. What follows are pointers to the canonical files. If something here
disagrees with the file it points at, the file wins (ADR-004).

## Decision records

| Record  | File                                       | Status                                     |
| ------- | ------------------------------------------ | ------------------------------------------ |
| ADR-000 | `docs/adrs/ADR-000-architecture.md`         | Accepted                                   |
| ADR-001 | `docs/adrs/ADR-001-memory-model.md`         | Accepted, partially superseded by ADR-013   |
| ADR-002 | `docs/adrs/ADR-002-autonomy-gears.md`       | Accepted                                   |
| ADR-003 | `docs/adrs/ADR-003-capability-contracts.md` | Accepted, amended by ADR-017                |

The full set, including the decisions that changed the shape of the project (ADR-011 Effect,
ADR-013 memory revision, ADR-016 Restate, ADR-017 MCP, ADR-018 Postgres, ADR-019 timestamps), is in
`docs/adrs/`.

## Contracts

| Contract         | File                                       |
| ---------------- | ------------------------------------------ |
| Intent (record)  | `specs/Intent.schema.json`                 |
| Intent (request) | `specs/IntentDraft.schema.json`            |
| Plan             | `specs/Plan.schema.json`                   |
| Artifact         | `specs/Artifact.schema.json`               |
| Event            | `specs/Event.schema.json`                  |
| ToolSpec         | `specs/ToolSpec.schema.json`               |
| Shared types     | `specs/common/`                            |
| Capability I/O   | `specs/capabilities/`                      |
| Core API         | `specs/api/openapi.yaml`                   |
| Event channels   | `specs/events/asyncapi.yaml`               |
| Storage vectors  | `specs/storage/conformance/`               |

## Storage interfaces

`docs/adrs/ADR-007-storage-interfaces.md`. Note that it now defines **two** roles, not four —
ADR-013 dropped the dedicated graph store and delegated retrieval to an external service.

## Phase 0 status

Phase 0 as originally written ("monorepo, CI, Tool Registry validation, ADR-000/001/002") was never
completed and has been superseded by Stage 0 of `docs/planning/REBUILD-PLAN.md`, which is scoped to
fixing spec/code drift rather than adding structure. Read the rebuild plan, not this file, for what
happens next.
