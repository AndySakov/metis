# ADR-020: Isolation Is a Policy Input, and Tool Behaviour Is Registry-Declared

Status: Accepted
Relates: ADR-002 (autonomy gears), ADR-003 (capability contracts), ADR-006 (registry governance),
ADR-008 (policy as code), ADR-014 (policy efficacy and trust), ADR-017 (MCP tool boundary)

## Context

A survey of thirteen coding-agent harnesses and two empirical studies of the wider corpus turned up
two findings that bear directly on this repository.

**The first is a position.** Across roughly seventy projects, audit capability distributes as: no
audit 40%, basic logging 35%, structured audit 20%, tamper-evident 5%. Isolation distributes as: no
sandbox 17%, process separation 45%, container 31%, WASM 7%. METIS sits in the 5% on audit and the
45% on isolation.

**The second is a correlation, and it is the uncomfortable one.** Container-isolated projects
implement a policy engine 100% of the time; projects without isolation do so 23% of the time
(support 0.89, lift 3.4). The ordinary path is to build containment first and govern it afterwards.
METIS did the reverse: it has a policy engine with a matched-rule field, a measured unmatched
fraction and a two-ledger trust model, running on the isolation tier that policy engines usually
are not built on.

That inversion is not automatically wrong. But it means the safety story currently rests on a layer
that cannot enforce it. Policy decides whether a dispatch is allowed; nothing decides what the tool
can do once dispatched. `ToolSpec.isolation` is honest about this — `"process"` is its only legal
value, with a comment saying a boolean `sandboxed: true` would assert containment that does not
exist — but honesty in a descriptor is not enforcement.

The relevant prior art is Codex CLI, which runs **two orthogonal policies** on every turn:
a sandbox policy (`read_only` / `workspace` / `danger_full_access`) governing what is *possible*,
and an approval policy (`Never` / `OnRequest` / `UnlessTrusted` / `Granular`) governing when a human
is *asked*. The two are deliberately decoupled: a command may clear approval and still fail the
sandbox. Claude Code closes the loop from the other side — with sandboxing enabled,
`autoAllowBashIfSandboxed` lets the sandbox boundary *replace* per-command prompting.

METIS has only the approval axis. The autonomy gear drives whether a human is asked; containment is
not modelled in policy at all, so no rule can require it and no decision can turn on it.

## Decision

**Two decisions, both narrow.**

### 1. Isolation becomes a policy input

`PolicyRequest` gains an `isolation` field carrying the containment actually in force for this
dispatch. It is supplied by the executor from the resolved `ToolSpec`, and policy rules may require
a minimum tier — so a rule can say that running unattended at S4 requires container isolation or
better, and a plan that cannot meet it is denied or downgraded to an approval rather than silently
running less contained than the rule intended.

`ToolSpec.isolation` widens from the single literal `"process"` to an **ordered ladder**:

```
none < process < container < wasm
```

Ordered, because "at least this contained" is the only comparison a rule needs, and an unordered
enum would push that ordering into rule-evaluation code where it could not be inspected.

**No descriptor may declare a tier above `process` until that tier actually exists.** The ladder is
the vocabulary; the runtime is a separate piece of work. A descriptor claiming `container` before
there is a container is precisely the `sandboxed: true` lie the current comment refuses to tell,
with more syllables.

### 2. Tool behaviour is declared by the registry, never by the server

MCP defines `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, and the
specification states that clients **MUST** treat these annotations as untrusted unless the server is
trusted. At least one shipping harness (Goose, in `SmartApprove` mode) auto-approves on the server's
own `read_only_hint` — a server declaring itself read-only is thereby permitted to skip
confirmation.

METIS already avoids this, by construction rather than by intent: `ToolSpec.idempotent` is declared
in the registry descriptor that METIS controls, not read from the server's advertisement. **This
ADR makes that an invariant rather than an accident.** Any behavioural annotation admitted in
future — read-only, destructive, open-world — is registry-declared and version-pinned like
`idempotent` is. A server's self-description may inform the descriptor when it is written; it never
reaches a policy decision at dispatch time.

## Rationale

Separating the axes is what makes the gears mean something enforceable. Today S4 means "policy and
the trust ledger decided nobody needs to watch." It cannot also mean "and the thing that runs is
contained," because no part of the system knows whether it is. Once isolation is an input, that
second clause is a rule with a conformance vector rather than a hope.

It also converts a known gap from prose into a measurable one. ADR-014 counts the fraction of
evaluations no rule matched. Once isolation is an input, an unmatched-isolation rule is countable
the same way, and the honest admission that "tool isolation is process-level only" stops living in
CLAUDE.md's open-decisions list and starts living in the coverage report.

The registry-declared invariant is the cheaper of the two decisions and the easier to lose. It costs
nothing today and would be very hard to retrofit after the first policy rule reads a field that
happens to come from a server, because the resulting rule looks correct and tests green — the tool
says it is read-only and the tool is telling the truth, until one is not.

## Consequences

- The WASM component host moves from an open decision to a **named tier on a ladder policy can
  already reference**. It stays unbuilt, but the shape it must fill is now fixed.
- Widening the `isolation` literal touches `src/domain/ToolSpec.ts`, `specs/ToolSpec.schema.json`
  and every example descriptor, and `test/specs/` reconciles the two. A new rule form additionally
  requires its own vector under `specs/policy/conformance/` — a rule shape with no vector is
  untested safety code.
- **Deliberately not implemented in the commit that adds this ADR.** The decision is recorded; the
  schema change, rule grammar, conformance vector and executor plumbing are a unit of work of their
  own. Recording a decision and shipping it in one commit is how the spec and the code drift apart.
- Until a tier above `process` exists, the practical effect of decision 1 is a rule that can *deny*
  for insufficient containment. That alone is worth having: it is the difference between an
  unattended run that nobody constrained and one that was refused for a stated reason.

## References

- ADR-002 Autonomy Gears
- ADR-003 Capability Contracts
- ADR-014 Policy Efficacy and Trust
- ADR-017 Tool Boundary — MCP
- MCP tool annotations: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Codex CLI sandbox and approval policies: https://deepwiki.com/openai/codex/2.4-sandbox-and-approval-policies
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Architectural Design Decisions in AI Agent Harnesses: https://arxiv.org/html/2604.18071v1
- Inside the Scaffold — a source-code taxonomy of coding agent architectures: https://arxiv.org/html/2604.03515
