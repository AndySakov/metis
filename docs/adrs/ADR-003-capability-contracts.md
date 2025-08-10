# ADR-003: Capability Contracts & Plugin ABI

Status: Accepted

## Context

METIS needs stable, long-lived capability contracts so the planner targets "what" (capabilities) rather than "how" (specific tools). Implementations should be hot-swappable, upgradeable, and independently deployable behind these contracts. We also need a minimal plugin ABI to package tools (container or WASM), validate them via a registry, and roll them out safely (canary, rollback, signing).

## Decision

Adopt Capability Contracts and a Plugin ABI with the following principles:

### Capability Contracts (CAP IDs)

- Identifier: `domain.action@MAJOR.MINOR` (e.g., `research.search@0.1`).
- Semantics: the contract defines inputs, outputs, side-effect scopes, and behavioral guarantees.
- Versioning:
  - MAJOR: breaking changes to inputs/outputs or guarantees; requires explicit planner opt-in.
  - MINOR: additive and backward-compatible; planner supports N-2 MINOR within a MAJOR.
  - PATCH: non-contractual fixes; not visible in CAP ID.
- Deprecation policy: deprecations announced at MINOR, removed at next MAJOR; registry surfaces warnings.

### Tool Specification (registry schema)

Tools must conform to `ToolSpec`:

- `name` (string), `version` (SemVer), `capability` (CAP ID),
- `implementation` { `kind`: `container`|`wasm`, image/entrypoint details TBD },
- `inputSchema`, `outputSchema` (JSON Schema 2020-12),
- `scopes` (permissions), `sandboxed` (bool), `tests` (conformance vectors).

### Plugin ABI and Packaging

- Packaging formats: container image or WASM module (TBD details per tool class).
- Invocation metadata: tools receive structured input matching `inputSchema` and return output matching `outputSchema`.
- Health and readiness: tools expose a lightweight health signal suitable for canarying and rollback.
- Isolation: sandboxed execution by default; least-privilege scopes granted by the orchestrator.

### Rollout & Safety

- Registration: tools are registered in the Tool Registry with schema validation and conformance checks.
- Hot-swap: multiple implementations may satisfy the same CAP; orchestrator selects by policy.
- Canary & rollback: percentage/shadow rollouts, fast rollback on health/regression signals.
- Signing & attestation: optional supply-chain checks; recommended for higher-risk domains.

## Consequences

- Decouples planning from implementation details; enables multiple interchangeable tools per capability.
- Requires disciplined versioning, schema validation, and CI-backed conformance tests.
- Enables safe evolution via additive MINORs, canaries, and rollbacks.

## References

- Capability contracts and Plugin ABI in `README.md`
- Contracts & Schemas in `README.md` section "Contracts & Schemas (Essentials)"
