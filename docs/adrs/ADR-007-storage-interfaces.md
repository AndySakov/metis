# ADR-007: Storage Interface Contracts

Status: Proposed

## Context

METIS relies on multiple complementary stores to capture timeline events, provenance graphs, vector retrieval, and versioned artifacts. We need clear, stack-neutral contracts to enable in-memory dev implementations now and pluggable backends later.

## Decision

Define four storage roles with transport-agnostic operations and guarantees. HTTP shapes shown below are examples for dev/debug; no separate API service layer is required. Adapters are in-process libraries implementing the contracts.

- EventLogStore (timeline)
  - Purpose: immutable/logical append of intents, plans, tool calls, approvals, writes.
  - Guarantees: append-only, idempotent by `id`, ordered by `ts` (UNIX epoch seconds).
  - Operations:
    - put(Event): idempotent by `id`
    - list({fromTs?, toTs?, types?, project?}) → Event[]
    - query(filterDsl) → Event[]
  - Example HTTP shape (optional, for dev):
    - `PUT /eventlog/{id}` body: `Event` → 201/200
    - `GET /eventlog?fromTs&toTs&types[]&project`
    - `POST /eventlog/_query` body: filter DSL (AND/OR on fields)

- GraphStore (provenance & work graph)
  - Purpose: entities (Project, Artifact, Decision, Claim, Source, Person) and relations.
  - Guarantees: transactional upserts; referential integrity on `(from, rel, to)`.
  - Operations:
    - upsertNodes(GraphNode[])
    - upsertEdges(GraphEdge[])
    - query(patternDsl) → Triples/paths
  - Example HTTP shape (optional):
    - `POST /graph/nodes` body: array of `GraphNode`
    - `POST /graph/edges` body: array of `GraphEdge`
    - `POST /graph/query` body: pattern DSL

- VectorIndex (retrieval)
  - Purpose: ANN search over chunked artifacts/notes.
  - Operations:
    - upsert(collection, VectorItem)
    - search(collection, {embedding, k, filters?}) → hits with `score` + `meta`
  - Example HTTP shape (optional):
    - `POST /vectors/{collection}` upsert `VectorItem`
    - `POST /vectors/{collection}/search` `{embedding, k, filters}` → hits

- ArtifactStore (blobs)
  - Purpose: versioned blobs with checksums and metadata.
  - Operations:
    - put(id, bytes, metadata)
    - get(id) → { bytes, metadata }
    - head(id) → metadata
  - Example HTTP shape (optional):
    - `PUT /artifacts/{id}` body: bytes + metadata
    - `GET /artifacts/{id}` → bytes + metadata
    - `HEAD /artifacts/{id}` → metadata

Conventions:

- IDs: ULID (or UUIDv7) preferred for sortability; timestamps as UNIX epoch integers.
- Checksums: SHA-256 recommended, content-addressable identifiers optional.

Conformance:

- Typed adapter contracts live in `specs/storage/contracts.ts`.
- A conformance suite exercises idempotency, ordering, referential integrity, and search quality (shape only) using JSON test vectors under `specs/storage/conformance/`.

Non-goals:

- A mandatory API gateway for storage is out of scope. The Core API MAY expose read-only views for debugging but the orchestrator talks directly to adapters.

## Consequences

- Enables in-memory dev impls with same surface as production backends.
- Clear seams for swapping graph/vector/blob vendors without changing contracts.
- Adds discipline around IDs and referential integrity.

## References

- `specs/Event.schema.json`, `specs/Artifact.schema.json`
- `specs/storage/GraphNode.schema.json`, `specs/storage/GraphEdge.schema.json`, `specs/storage/VectorItem.schema.json`
