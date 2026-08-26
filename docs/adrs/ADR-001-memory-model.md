# ADR-001: Memory Model

Status: Accepted (partially superseded by ADR-013 — the three-store decision only; the provenance rules still hold)

## Context

METIS requires a memory fabric with provenance so that ideas, artifacts, and actions can be traced, audited, and reused. We need multiple complementary stores to capture timeline events, relationships, semantic neighborhoods, and versioned artifacts.

## Decision

Adopt a memory model composed of four primary interfaces:

- EventLogStore: append-only timeline of intents, plans, tool events, approvals, preferences.
- GraphStore: provenance and work graph linking projects, artifacts, decisions, claims, and sources.
- VectorIndex: approximate nearest neighbor retrieval over personal exemplars, project context, and corpora.
- ArtifactStore: versioned blob/object storage with checksums and metadata.

Guarantees and behaviors:

- Append-only semantics for EventLogStore with monotonic IDs or timestamps.
- Strong provenance via graph edges and artifact checksums.
- Eventual consistency across stores via shared IDs and referential integrity checks.
- Versioned artifacts with immutable content-addressed references where possible.

Development posture:

- Provide in-memory implementations with the same HTTP surfaces to unblock the core loop.
- Defer concrete datastore choices to later phases via ADRs with migration plans.

## Consequences

- Enables retrieval, claim graphs, and end-to-end auditability.
- Adds synchronization complexity; requires clear ID and versioning conventions.
- Facilitates local-first privacy by allowing connector-scoped ingestion and redaction paths.

## References

- Memory Fabric in `README.md`
- Storage Interfaces in `README.md` section "Storage Interfaces (Stack-Neutral)"
