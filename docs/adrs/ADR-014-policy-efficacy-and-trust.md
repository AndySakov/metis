# ADR-014: Policy Efficacy, Coverage, and Two-Ledger Trust

Status: Accepted

## Context

METIS's safety argument is entirely preventive: constrain the action space from move one, gate anything consequential, and let autonomy rise only as trust is earned. The mechanisms for this exist — gears (ADR-002), policy-as-code (ADR-008), capability governance (ADR-006).

There is a hole in the middle of it. **Nothing in the system measures whether the prevention is working.**

Two specific failures follow from that:

1. **Trust measures the wrong quantity.** ADR-002 promotes trust on "low edit ratio, high success" — that is, on METIS being *useful*. A skill that drafts excellent documents would ratchet toward S4 scheduled autonomy on the strength of its writing quality, with no evidence whatsoever that its constraints hold. Usefulness and safety are different properties and the current design conflates them.

2. **Policy coverage is unknown and unknowable.** The system cannot currently answer "did any rule have an opinion about what just happened?" An action that passes through with no rule matching is indistinguishable from an action that was explicitly permitted. The fraction of behavior that is actually governed is unmeasured — and a constraint-first architecture that cannot report its own coverage is asserting safety rather than demonstrating it.

Relevant external evidence: recent work on runtime monitoring for agents shows that a fixed set of rules has a hard ceiling on what it can catch, determined by how dispersed the failure modes are, and that re-deriving rules from the failures they missed produces no improvement. Coverage is therefore a property to be *measured*, not a target to be reached by writing more rules.

## Decision

### 1. Every policy evaluation records whether a rule matched

The `PolicyEngine` decision type carries the matched rule identity, or an explicit `unmatched` marker. This field is required, not optional. Every evaluation is written to the event log.

### 2. Coverage is a reported metric

METIS reports, per window:

- **Unmatched fraction** — the share of evaluations where no rule engaged. This is the honest measure of ungoverned behavior.
- **Dead rules** — rules that have never fired in production. Either the risk never materialized or the rule does not work; both need investigation.
- **Vacuous rules** — rules that fire on effectively everything, and therefore constrain nothing.

The unmatched fraction will be high at first. That is the point of measuring it.

### 3. Trust splits into two independent ledgers

Per skill, per domain:

- **Competence** `[0,1]` — task success, edit ratio, acceptance rate, first-try success. Rises when METIS does the job well.
- **Compliance** `[0,1]` — policy evaluations survived, gates cleared without override, absence of red-line approaches, verified-clean rate on audited samples. Rises **only** on safety evidence.

Rules:

- **Promotion to a higher gear requires both ledgers above threshold.** Competence alone is insufficient and can never substitute.
- **Demotion on a compliance event is immediate** and does not wait for decay.
- Both ledgers decay, with explicit half-lives recorded in policy rather than described as "decays over time."
- The ledgers are stored, versioned and auditable. Any promotion or demotion is an event in the log with its justification attached.

### 4. Sampled verification

A random sample of executed actions is verified against expectation, independent of whether any rule flagged them. The sampling rate is policy-configured. Sample results feed the compliance ledger.

This exists because rules only catch what they were written for. Random sampling is the only mechanism that can find the failure nobody anticipated, and it is how every serious auditing discipline outside software has handled volume for a century.

Note the limitation honestly: sampling bounds how *often* things go wrong. It will not reliably find a single rare catastrophic action. Do not conflate the two, in the code or in any claim made about the system.

### 5. Adversarial testing is a standing requirement

A red-team suite runs in CI, attempting actions policy is supposed to forbid. Its pass rate is recorded over time. A policy change that does not move the red-team number has not been shown to do anything.

## Consequences

- Additional field on every policy decision and an event written per evaluation. Storage cost is real and acceptable.
- The coverage number will be uncomfortable early on. Resist the temptation to write rules purely to move it — a rule that fires on everything improves coverage and constrains nothing, which is why vacuous rules are tracked.
- Autonomy ramps more slowly than a competence-only design would allow. That is the intended trade.
- This is the part of METIS with no equivalent in existing agent tooling. Trace viewers show what happened; none of them report what fraction of behavior was actually governed. It is worth building carefully and worth writing about.

## References

- ADR-002 Autonomy Gears & Approvals
- ADR-008 Policy-as-Code
- `docs/planning/Limits-and-Guardrails.md`
- `docs/planning/REBUILD-PLAN.md` — Stages 3 through 5
