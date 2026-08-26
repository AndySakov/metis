# ADR-017: Tool Boundary — MCP Transport, Capability IDs on Top

Status: Accepted
Amends: ADR-003, ADR-006

## Context

The original design specified a bespoke tool interface: ToolSpecs describing inputs, outputs, scopes and tests, with tools packaged as containers or WASM modules behind a custom loader. The planner targets capability IDs (`domain.action@MAJOR.MINOR`) rather than implementation names.

The capability-ID abstraction is correct and stays. The transport underneath it does not need to be invented. MCP has become the de facto standard for tool interfaces, which means a bespoke protocol buys nothing and costs an ecosystem — every tool anyone else writes would be unavailable without an adapter.

## Decision

**MCP is the wire protocol at the tool boundary. Capability IDs remain the semantic layer above it.**

- The **planner targets CAP IDs**, exactly as before. It never names an MCP server or tool.
- The **registry maps a CAP ID to one or more MCP tool implementations** — server identity, tool name, and version. Multiple implementations may satisfy one capability; policy selects between them.
- **ToolSpec becomes a thin descriptor** wrapping the MCP tool with the metadata METIS needs and MCP does not carry: required auth scopes, budgets, sandboxing expectations, idempotency declaration (ADR-016), conformance test vectors, and the CAP ID binding.
- **Policy enforcement stays entirely on the METIS side**, at dispatch. MCP has no permission model of its own; it describes tools, it does not constrain them. Nothing about adopting it weakens ADR-008 — but nothing about it helps either, and that must not be forgotten.

## Sandboxing

MCP servers are separate processes, so isolation at this stage is **process isolation** — the operating system's boundary, plus whatever scoping METIS applies at dispatch. That is weaker than the container-or-WASM story in ADR-003.

**WASM components are the intended destination, not the starting point.** WASI's capability model is a direct match for policy-as-code: a module can only reach what it was explicitly granted, enforced by the runtime rather than by METIS's own checks. When a WASM component host is added, it will get its own ADR. Until then, be explicit that tool isolation is process-level and treat any tool as trusted-by-configuration rather than sandboxed.

## Rationale

The capability layer was always the valuable part — it is what makes hot-swap, versioning, policy attachment and the graduation loop coherent. The transport was incidental, and building an incidental thing from scratch is how solo projects die.

Adopting MCP means the Adaptive Agent Foundry's graduation loop (agent → evidence → parameterize → PR → permanent tool) now produces an MCP server, which is immediately useful outside METIS as well.

## Consequences

- Inherit the MCP ecosystem. Third-party tools become available without bespoke adapters.
- Dependent on MCP's evolution. Mitigated by CAP IDs sitting above it — if MCP is replaced, the planner and policy layers are untouched and only the registry's resolution step changes.
- **Tool isolation is weaker than originally designed until a WASM host exists.** This is a real, currently-open gap and should be stated plainly in the Limits doc rather than glossed.
- `specs/ToolSpec.schema.json` must be reworked: drop the `implementation` block's container/WASM assumptions, add MCP binding, idempotency, and keep scopes, costs and tests.
- ADR-006's registry validation rules still apply — schema validation, at least one passing conformance vector per capability version, declared scopes.

## References

- ADR-003 Capability Contracts & Plugin ABI
- ADR-006 Tool Registry Governance
- ADR-008 Policy-as-Code
- ADR-016 Durable Execution (idempotency requirement)
- `docs/capabilities/Adaptive-Agent-Foundry.md`
