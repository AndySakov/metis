# ADR-013: Memory Model Revision — Two Tiers, Not Three

Status: Accepted
Supersedes: ADR-001 (partially — the three-tier decision only)

## Context

ADR-001 specified a three-tier memory model: a graph store for provenance and the work graph, a vector index for retrieval, and an event/timeline store.

The implementation went a different way without recording it. `src/mneme/GraphStore.ts` is commented out in full. The vector index was never built — `src/mneme/SuperMemory.ts` delegates to a third-party service instead. The repo therefore has a documented architecture nobody is building and an actual architecture nobody has documented.

This ADR records what is actually true and why it is acceptable.

## Decision

METIS runs a **two-tier memory model** with an external retrieval service.

1. **Structured store (Gel)** — events, timeline, intents, plans, artifact metadata, and provenance relationships expressed as links rather than as a separate graph database.
2. **Artifact store** — versioned, checksummed blobs.
3. **Retrieval (supermemory, external)** — embedding, indexing and semantic search, behind a `Context.Tag` interface.

The dedicated graph store is dropped for now.

## Rationale

The provenance relationships ADR-001 called for — artifact derives-from source, decision justified-by claim, artifact in-project project — are link traversals one or two hops deep. Gel's link model expresses them natively. A separate graph database earns its keep on deep, variable-length traversals over large graphs, and METIS has no such workload and will not have one for a long time.

Running a second store for a single-user system that does not need it is cost without benefit.

Retrieval is delegated because embedding pipelines, chunking strategies and index maintenance are a significant build with no METIS-specific insight in them. It is behind an interface, so the decision is reversible.

## Consequences

- **Vendor dependency on a retrieval service.** Mitigated by the `Context.Tag` boundary — swapping to a self-hosted index means writing one adapter. Do not let supermemory-specific concepts leak past that interface.
- Deep provenance queries, if they ever appear, will be awkward in Gel. Revisit this ADR when a real traversal workload exists rather than in anticipation of one.
- **ADR-001 is now partially superseded.** Its provenance *rules* still hold: every artifact has a checksum, a creator and provenance links; context packs are assembled per request; redaction happens at ingest. Only the three-store decision is replaced.
- `src/mneme/GraphStore.ts` and `src/mneme/MemoryFabric.ts` are commented-out code and must be deleted. Commented-out code is not a design record — this ADR is.

## References

- ADR-001 Memory Model
- ADR-012 Datastore Selection
- `src/mneme/`
