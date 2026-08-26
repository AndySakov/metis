# ADR-008: Policy-as-Code for Autonomy & Safety

Status: Accepted
Amended by: ADR-014 (coverage and two-ledger trust)

## Context

Autonomy gears (ADR-002) require enforceable rules for approvals, scopes, data handling, and forbidden actions. Policies must be auditable, versioned, and testable.

## Decision

- Define a policy-as-code layer enforced by the orchestrator and registry:
  - Deny/allow rules for tool scopes and capabilities.
  - Approval requirements for gears S3/S4 with cost/time thresholds.
  - Data retention and redaction rules by bucket.
- Policy representation: declarative JSON/YAML with a small DSL; evaluators pluggable (e.g., OPA/Rego or native).
- Policy evaluation points:
  - Plan validation (pre-execution): gate steps requiring approval or forbidden scopes.
  - Tool dispatch: enforce scopes and budgets.
  - Artifact write: enforce redaction/licensing checks.
- Versioning & tests:
  - Policies stored as artifacts; changes reviewed via PR.
  - Each policy has unit tests with example inputs/expected decisions.

## Consequences

- Clear, testable safety controls; auditable approvals.
- Requires maintenance of policy tests and evaluation plumbing.

## References

- ADR-002 Autonomy Gears & Approvals
- ADR-006 Tool Registry Governance
