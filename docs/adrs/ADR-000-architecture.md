# ADR-000: Architecture

Status: Accepted

## Context

METIS requires a durable, composable architecture that supports real-time interaction, tool orchestration, memory with provenance, and safe autonomy. We must also preserve the ability to evolve implementation choices over time without breaking contracts.

## Decision

Adopt a layered, stack-neutral architecture with the following layers:

1. Interface: realtime voice & chat, multimodal canvas, command palette
2. Orchestrator: intent → plan → tool dispatch → memory writes
3. Memory Fabric: event/relational store, graph store, vector index, artifact/object store
4. Knowledge Engine: multi-corpus retrieval, claims/evidence, licensing flags
5. Tooling/Execution: container/WASM tools, notebook runner, CI hooks
6. Governance/Safety: capability gating, approvals, policy-as-code, audit
7. Observability: traces, cost/latency budgets, eval dashboards

Foundational capabilities:

- Capability Contracts (CAP IDs) `domain.action@MAJOR.MINOR` (planner targets capabilities, not implementations)
- Plugin ABI and hot-swap via portable module format (containers or WASM), with health checks, canary, and rollback
- State migrations for selected datastores with dry-run and revert
- Feature flags/experiments with shadow/percent rollouts

Interface layer:

- Headless Core API (protocol TBD: gRPC/GraphQL/HTTP)
- Presence and handoff across clients; UI SDKs for plan view, diffs, claim graph, approvals

## Consequences

- Enables incremental choice of datastores and protocols behind stable capability contracts
- Supports safe evolution via hot-swap, canaries, and rollbacks
- Clear separation of concerns simplifies testing and evaluation
- Requires disciplined contract/version management and CI validation

## References

- Tenets in `README.md`
- Layers and capabilities in `README.md` section "Architecture (Stack-Neutral)"
