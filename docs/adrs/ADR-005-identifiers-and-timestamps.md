# ADR-005: Identifiers & Timestamps Conventions

Status: Proposed

## Context

We need consistent, sortable identifiers and timestamps across stores and APIs to simplify querying, ordering, and replication. Earlier drafts mixed integer epoch and RFC3339 timestamps.

## Decision

- Use UNIX epoch seconds as integers for all timestamps in public schemas (`ts`, `created_at`, etc.).
- Prefer monotonic, sortable IDs for primary entities and events. Recommendation: ULID (or UUIDv7 if available) for lexicographic ordering by time.
- Event log semantics:
  - `id`: ULID identifying the event (idempotency key).
  - `ts`: integer UNIX epoch seconds set by the orchestrator when the event is accepted.
- Clients MAY propose timestamps; the server is authoritative for persisted `ts`.
- Query parameters that filter by time use integer UNIX epoch values.

## Consequences

- Simpler numeric comparisons and range scans; no timezone parsing issues.
- Cross-language marshaling is straightforward; consistent storage.
- Requires consumers to format for human display when needed.

## References

- `specs/Event.schema.json`, `specs/api/openapi.yaml`
- ULID spec; UUIDv7 draft
