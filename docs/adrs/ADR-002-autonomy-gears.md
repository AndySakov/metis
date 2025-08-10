# ADR-002: Autonomy Gears & Approvals

Status: Accepted

## Context

METIS should operate safely across a continuum of autonomy, from advising to scheduled autonomous actions. We need explicit gears, approvals, and auditability to manage risk and build trust over time.

## Decision

Adopt autonomy gears and approvals with the following levels:

- S0: Advise — suggestions only, no side effects.
- S1: Draft — generate artifacts/drafts, no execution.
- S2: Sandbox run — execute in isolated environment; no external side effects.
- S3: Gated run — execute with user approval gates; diff and cost/time surfaced.
- S4: Scheduled autonomy — execute on a schedule with policy gates and notifications.

Policies and controls:

- Trust ledger per skill/domain; promotions gated by metrics and decaying over time.
- Dual-key approvals for high-risk actions; policy-as-code for enforcement.
- Tamper-evident event logging across all gears; diffs and provenance required.

## Consequences

- Clear user controls and approvals reduce risk and improve auditability.
- Requires robust policy evaluation and UI surfaces for diffs and approvals.
- Enables gradual autonomy ramp aligned with user trust.

## References

- Tenets and Security in `README.md`
- "Autonomy gears" definition in `README.md`
