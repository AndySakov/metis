/**
 * Policy evaluation (ADR-008, ADR-014).
 *
 * Deliberately boring: matching is pure, total, and has no I/O. Anything a rule needs is on the
 * `PolicyRequest`, so a decision can be re-made from scratch at any time — which is what ADR-016
 * requires on workflow resume, where a cached allow from before a suspension is invalid because
 * both the policy and the trust ledger may have moved underneath it.
 */

import { Context, Effect, Layer } from "effect"

import type { EpochSeconds } from "../domain/Common.js"
import type { Policy, PolicyBasis, PolicyEffect, PolicyRequest, PolicyRule } from "../domain/Policy.js"
import { PolicyDecision } from "../domain/Policy.js"

/** Fail-safe ordering: the strictest effect wins a priority tie. */
const SEVERITY: Record<PolicyEffect, number> = { deny: 0, require_approval: 1, allow: 2 }

/**
 * `agent.*` matches `agent.web_navigate@1.0`; an exact id matches only itself.
 *
 * Kept to prefix globs rather than full regex on purpose — a policy language that can express
 * anything is a policy language nobody can audit.
 */
const capabilityMatches = (pattern: string, capability: string): boolean =>
  pattern.endsWith("*") ? capability.startsWith(pattern.slice(0, -1)) : pattern === capability

const overlaps = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.some((item) => b.includes(item))

/**
 * Whether a rule's conditions all hold. Absent conditions do not constrain; a rule with no
 * conditions therefore matches everything.
 */
export const ruleMatches = (rule: PolicyRule, request: PolicyRequest): boolean => {
  const when = rule.when

  if (when.at !== undefined && when.at !== request.at) return false
  if (when.autonomy !== undefined && !when.autonomy.includes(request.autonomy)) return false

  if (when.capabilities !== undefined) {
    // A capability-scoped rule cannot match a request that names no capability — otherwise
    // `deny agent.*` would also block plan validation for a plan with no tool steps.
    if (request.capability === undefined) return false
    if (!when.capabilities.some((pattern) => capabilityMatches(pattern, request.capability!))) return false
  }

  if (when.scopes !== undefined && !overlaps(when.scopes, request.scopes)) return false
  if (when.tags !== undefined && !overlaps(when.tags, request.tags)) return false

  if (when.minDollars !== undefined) {
    if (request.estimatedDollars === undefined || request.estimatedDollars < when.minDollars) return false
  }
  if (when.minSeconds !== undefined) {
    if (request.estimatedSeconds === undefined || request.estimatedSeconds < when.minSeconds) return false
  }
  if (when.nonIdempotent === true) {
    // Absent idempotency information is treated as non-idempotent: ADR-016 requires an explicit
    // declaration, and the safe reading of "not stated" is the one that cannot replay a side effect.
    if (request.idempotent === true) return false
  }

  return true
}

/** All matching rules, most authoritative first. */
export const rank = (policy: Policy, request: PolicyRequest): Array<PolicyRule> =>
  policy.rules
    .filter((rule) => ruleMatches(rule, request))
    .slice()
    .sort((a, b) => (a.priority === b.priority ? SEVERITY[a.effect] - SEVERITY[b.effect] : a.priority - b.priority))

export const decide = (policy: Policy, request: PolicyRequest, ts: EpochSeconds): PolicyDecision => {
  const matched = rank(policy, request)
  const winner = matched[0]

  const basis: PolicyBasis = winner === undefined ? { _tag: "unmatched" } : { _tag: "matched", ruleId: winner.id }

  return new PolicyDecision({
    at: request.at,
    effect: winner?.effect ?? policy.defaultEffect,
    basis,
    policyVersion: policy.version,
    consideredRuleIds: matched.map((rule) => rule.id),
    ts
  })
}

export class PolicyEngine extends Context.Tag("policy/PolicyEngine")<PolicyEngine, {
  readonly evaluate: (request: PolicyRequest) => Effect.Effect<PolicyDecision>
  readonly policy: Effect.Effect<Policy>
}>() {}

/**
 * An engine over a fixed policy.
 *
 * The clock is read per evaluation rather than passed in, so a decision's timestamp is the moment
 * it was actually made — relevant because decisions are written to the event log and a resumed
 * workflow's re-evaluation must be distinguishable from the original.
 */
export const make = (policy: Policy) =>
  PolicyEngine.of({
    evaluate: (request) =>
      Effect.map(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (millis) => decide(policy, request, Math.floor(millis / 1000) as EpochSeconds)
      ),
    policy: Effect.succeed(policy)
  })

export const layer = (policy: Policy) => Layer.succeed(PolicyEngine, make(policy))
