# ADR-007: Storage Interface Contracts

Status: Accepted
Amended by: ADR-011 (Effect `Context.Tag` is the interface mechanism), ADR-013 (GraphStore and
VectorIndex are no longer storage roles), ADR-018 (PostgreSQL), ADR-019 (epoch seconds in storage)

## Context

METIS relies on complementary stores to capture timeline events, provenance, and versioned
artifacts. We need clear contracts so adapters can be swapped without changing callers.

The original version of this ADR defined **four** storage roles and pointed at a stack-neutral
TypeScript file, `specs/storage/contracts.ts`, as the canonical shape. Both of those have since
changed and this ADR has been corrected rather than left describing a system nobody is building.

## Decision

### Storage roles

Two roles, not four. ADR-013 dropped the dedicated graph store and delegated retrieval to an
external service behind a `Context.Tag`.

- **EventLogStore** (timeline)
  - Purpose: append-only record of intents, plans, tool calls, approvals, policy evaluations, writes.
  - Guarantees: append-only; **idempotent by `id`** — a repeated append is one event and the first
    write wins; ordered by `ts`, with the identifier breaking ties within a second.
  - Operations:
    - `append(Event) → Event`
    - `read({fromTs?, toTs?, types?, actor?, project?}) → Event[]`

- **ArtifactStore** (blobs)
  - Purpose: versioned blobs with checksums and provenance.
  - Guarantees: content is checksummed on write and **verified on read**; metadata is retrievable
    without transferring the payload.
  - Operations:
    - `put(Artifact, payload) → Artifact`
    - `get(id) → { metadata, payload }`
    - `head(id) → Artifact`
    - `delete(id)`

**No GraphStore.** Provenance is expressed as foreign keys and the `artifact_provenance` table
(ADR-013). The traversals METIS actually needs are one or two hops.

**No VectorIndex.** Retrieval is delegated to supermemory behind the `mneme/SuperMemory` tag
(ADR-013). Do not let vendor concepts leak past that interface.

### Interfaces are `Context.Tag`s, not a TypeScript description file

The original `specs/storage/contracts.ts` has been **deleted**. It was a third definition of shapes
that already exist twice — once as JSON Schema in `specs/`, once as Effect Schema in `src/domain/`
— and it had drifted from both, still describing snake_case artifact metadata and the two dropped
stores. Three sources of truth for one contract is how the drift this repository was audited for
began.

The contract is now:

- **`specs/*.schema.json`** — canonical, language-neutral (ADR-004).
- **`src/domain/*.ts`** — the Effect Schema implementation, validated against the specs by
  `test/specs/SpecConformance.test.ts`.
- **`src/mneme/*.ts`** — the service interfaces as `Context.Tag`s (ADR-011), so any adapter can be
  swapped for a test double without touching callers.

A non-TypeScript adapter still has a language-neutral contract to implement: the JSON Schemas and
the conformance vectors. That was the actual purpose of `contracts.ts`, and it is better served
without a fourth copy.

### Conventions

- IDs: UUIDv7, time-sortable (ADR-005). Enforced at the storage edge by the `uuid_v7` domain.
- Timestamps: UNIX epoch seconds as `bigint`, at every layer (ADR-019).
- Checksums: SHA-256, stored as `sha256:<64 hex>` so they can be verified rather than merely held.

### Conformance

Vectors live under `specs/storage/conformance/`, one directory per interface:

- `eventlog/idempotency.json` — repeated append is one event, first write wins.
- `eventlog/ordering.json` — timeline order and integer range filtering.
- `artifact/checksum-and-metadata.json` — metadata without payload, checksum verified on read, a
  mismatched checksum rejected.

Adapters must pass the vectors for the interfaces they implement.

## Non-goals

A mandatory API gateway for storage. The Core API may expose read-only views for debugging, but the
orchestrator talks directly to adapters.

## Consequences

- Two stores rather than four: less to operate, and no store without a workload.
- Deep provenance queries would be awkward. Revisit ADR-013 when such a workload exists, not before.
- Vendor dependency on supermemory for retrieval, bounded by the `Context.Tag` seam.

## References

- ADR-005 Identifiers & Timestamps
- ADR-011 Effect Runtime
- ADR-013 Memory Model Revision
- ADR-018 Datastore — Bare-Metal PostgreSQL
- ADR-019 Epoch Seconds All The Way Down
- `specs/Event.schema.json`, `specs/Artifact.schema.json`
- `specs/storage/conformance/`
