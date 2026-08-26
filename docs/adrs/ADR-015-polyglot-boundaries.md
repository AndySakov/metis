# ADR-015: Polyglot Boundaries and Language Selection

Status: Accepted

## Context

METIS is not one workload. The orchestrator and planner spend almost all of their wall-clock waiting on model inference and network I/O, where language performance is irrelevant. The local device daemon, the ingest pipeline and the realtime voice gateway are throughput- and latency-bound, where it is not.

A single-language answer is wrong in both directions: forcing everything into TypeScript will hurt at the edges, and rewriting the core in a systems language would trade months of velocity for microseconds on a path dominated by network waits.

ADR-003 already establishes that the planner targets capability IDs rather than implementations, and ADR-007 states that storage adapters may be implemented in any language. The seams for a polyglot system exist. This ADR governs how and when to use them, so that "polyglot" does not decay into "a zoo."

## Decision

**TypeScript with Effect is the default and the core** (ADR-011). Everything is written there unless this ADR's bar is cleared.

**Other languages are permitted only at defined process boundaries.** A component may be written in another language when all three of the following hold:

1. **A measured need exists.** Not an anticipated one. A profile, a latency budget that is being missed, or a resource ceiling that has actually been hit.
2. **The boundary is a contract, not a shared library.** Communication crosses via a versioned schema — a capability contract, a storage adapter interface, or a documented wire protocol. No shared types, no shared memory, no build-time coupling.
3. **An ADR records it**, naming the component, the language, the measurement that justified it, and the contract at the seam.

**Anticipated boundaries**, none of which are approved yet:

- **Local device daemon** (mDNS, MQTT, IPP, SSH, WebDAV) — Rust. Single binary, low idle footprint, mature protocol libraries, and it must run continuously on a LAN machine. This is the most likely first non-TypeScript component.
- **Web Memory ingest** — Rust or Go, once crawl volume makes throughput the constraint. Not before.
- **Realtime voice gateway** — Rust or Go if audio streaming with barge-in misses its latency budget in Node. Measure first.

**The core orchestrator, planner, policy engine, trust ledger and memory layer stay in TypeScript.** They are not candidates for rewrite.

## Rationale

The dominant risk to METIS is not that it will be slow. It is that it will not ship. The project currently carries roughly 90KB of design documents against 8KB of source, and anything that reduces iteration speed now is a larger threat to the long-term scope than any performance ceiling reachable in the next two years.

Meanwhile the components that genuinely want a systems language are all at the periphery, all already isolated behind contracts in the existing design, and none of them are needed for the first working loop.

Deferring the decision per component, with a measurement requirement, gets the benefit of both without paying for either up front.

## Consequences

- Multiple toolchains once the first Rust component lands. Build, CI and release complexity increase at that point, not before.
- Contracts at the boundaries must be genuinely stable, because they can no longer be refactored by a single typechecker run. This is a cost, and it is also the discipline that keeps the seams real.
- Any temptation to share code across a boundary is a signal the boundary is in the wrong place. Move it or collapse it; do not bridge it.
- "Measure first" must be enforced. The failure mode is writing something in Rust because it is enjoyable rather than because it is necessary.

## References

- ADR-003 Capability Contracts & Plugin ABI
- ADR-007 Storage Interface Contracts
- ADR-011 Effect Runtime
- ADR-016 Durable Execution
- ADR-017 Tool Boundary
