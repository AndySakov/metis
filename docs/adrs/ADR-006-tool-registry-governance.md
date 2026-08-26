# ADR-006: Tool Registry & Capability Governance

Status: Accepted
Amended by: ADR-017 (MCP transport)

## Context

Capability contracts (ADR-003) need governance to ensure stability, safe evolution, and quality of tool implementations.

## Decision

- SemVer policy for capabilities:
  - MAJOR: breaking changes to inputs/outputs/guarantees; requires explicit planner opt-in.
  - MINOR: additive and backward-compatible; planner supports N-2 MINOR within a MAJOR.
  - PATCH: non-contractual fixes; invisible to CAP ID.
- Deprecation & removal:
  - Deprecations announced at a MINOR; removal occurs at next MAJOR.
  - Registry surfaces deprecation warnings; CI fails on using removed contracts.
- Registry validation requirements:
  - JSON Schema validation of `ToolSpec`, input/output schemas.
  - At least one passing conformance test vector per capability version.
  - `authScopes` declared; `isolation` stated honestly. ADR-017 replaced the `sandboxed` boolean
    with an `isolation` enum whose only value today is `process` — a boolean `true` asserted
    containment that does not exist.
  - `idempotent` declared explicitly, with no default (ADR-016).
- Rollout & safety:
  - Hot-swap loader supports canary/shadow rollouts and rollback.
  - Optional module signing/attestation in dev; recommended/required for higher-risk domains.
- Policy-as-code integration for approvals and forbidden scopes.

## Consequences

- Predictable evolution of capabilities; multiple implementations can coexist safely.
- Some overhead to maintain tests and deprecation windows.

## References

- ADR-003 Capability Contracts & Plugin ABI
- `specs/ToolSpec.schema.json`
