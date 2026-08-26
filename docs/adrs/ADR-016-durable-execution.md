# ADR-016: Durable Execution — Adopt Restate

Status: Accepted
Supersedes: the hand-built DAG scheduler in Phase 6a of the v1 roadmap

## Context

The roadmap calls for durable background DAGs with retries, backoff, checkpoints, and pause/resume/park — long-running plans that survive process restarts and can be interrupted mid-flight, have their persona swapped, and be resumed.

This is one of the hardest things on the roadmap. It is also entirely solved. Getting durable execution subtly wrong produces silent, hard-to-reproduce data loss: a step that ran twice, a checkpoint written before its side effect completed, a resume that replays an action which was not idempotent. These are precisely the failure modes METIS's safety architecture is supposed to prevent, and hand-rolling the machinery would introduce them at the foundation.

## Decision

Adopt **Restate** as the durable execution engine for long-running plans.

Plan execution becomes a Restate workflow. Restate owns retries, backoff, checkpointing, suspension and resumption. METIS owns planning, policy, tool dispatch and memory.

## Rationale

Restate fits this project specifically:

- **Rust core with a first-class TypeScript SDK** — the durable machinery is fast and the code that uses it stays in the Effect core (ADR-011, ADR-015).
- **Substantially lighter to operate than Temporal** for a single-user system. Temporal is more mature and has the larger ecosystem, but its operational footprint is sized for organisations.
- Suspension is native, which is exactly what pause/resume/park requires — a plan waiting for an S3 approval is a suspended workflow, not a polling loop.

DBOS was the runner-up and remains a reasonable fallback, since it runs on Postgres and METIS is on Postgres directly (ADR-018, superseding ADR-012).

## Design notes that matter

**Two logs, two purposes. Do not merge them.**
Restate keeps an execution journal — the mechanics of what ran, what retried, what resumed. METIS keeps its own event log (ADR-007) — the semantic and audit record: intents, plans, approvals, policy evaluations, artifact writes. The Restate journal is infrastructure and may be discarded on migration. The METIS event log is the tamper-evident record the safety story depends on and must never be delegated to a third party.

**Policy is re-evaluated on resume, never trusted from a checkpoint.**
A workflow suspended for an approval may resume hours later, under a policy version that has since changed, with a trust ledger that has since moved. Policy evaluation happens inside the durable step, on resume, against current state. A cached allow decision from before suspension is invalid.

**Every tool call must be idempotent or explicitly marked non-idempotent.**
Durable execution replays. A tool that charges money, sends a message, or drives a physical device cannot be replayed blindly. The ToolSpec needs an idempotency declaration, and non-idempotent steps must go through Restate's exactly-once mechanisms rather than plain retry.

## Consequences

- A new infrastructure dependency that must run alongside METIS. Acceptable for a single-user system; it is a single service.
- Workflow code is constrained — side effects go through the SDK, not around it. This is a real discipline cost and the reason the guarantees hold.
- Phase 6a shrinks from "build a durable DAG scheduler" to "model plans as Restate workflows," which is probably a three-to-six-month saving.
- Migration away from Restate later means rewriting workflow orchestration. Mitigated by keeping planning, policy and memory outside it — Restate schedules, it does not decide.

## References

- ADR-007 Storage Interface Contracts
- ADR-011 Effect Runtime
- ADR-014 Policy Efficacy and Trust
- ADR-015 Polyglot Boundaries
