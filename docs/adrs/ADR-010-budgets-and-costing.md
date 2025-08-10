# ADR-010: Budgets & Costing

Status: Proposed

## Context

Plans and tools need consistent time/cost/token budgets and a simple costing model so planners can trade off steps and surface approvals.

## Decision

- Introduce a shared `Budget` schema used in `Plan.ToolCall` and (optionally) in `ToolSpec.tests`.
- Budget fields (all optional): `seconds`, `dollars`, `tokens`.
- Tools MAY declare cost hints in `ToolSpec.costs` (`fixed`, `perUnit`), but planners treat them as hints.

## Consequences

- Consistent budget representation across planning and execution.
- Enables approval prompts tied to budgets and policy thresholds.

## References

- `specs/common/Budget.schema.json`
- `specs/Plan.schema.json`, `specs/ToolSpec.schema.json`
