/**
 * Policy rules and the decisions they produce (ADR-008, ADR-014).
 *
 * The load-bearing design choice here is that a decision always records **why** — either the rule
 * that matched, or an explicit marker saying nothing did. ADR-014 makes that field required rather
 * than optional, because an action that passed with no rule engaged is otherwise indistinguishable
 * from one that was deliberately permitted, and the difference is the entire coverage measurement.
 */

import { Schema } from "effect"

import { Actor, Autonomy, CapabilityId, EpochSeconds, LongText, Uuid7 } from "./Common.js"

export const PolicyRuleId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9_.-]*$/),
  Schema.annotations({ examples: ["deny.undeclared_scope", "approve.high_cost"] }),
  Schema.brand("PolicyRuleId"),
  Schema.annotations({ identifier: "PolicyRuleId" })
)
export type PolicyRuleId = typeof PolicyRuleId.Type

/**
 * Where in the execution path a decision is being made.
 *
 * Three points, per ADR-008 — enforcement belongs at the seams rather than in one chokepoint,
 * because each seam knows something the others do not.
 */
export const PolicyPoint = Schema.Literal("plan_validation", "tool_dispatch", "artifact_write")
export type PolicyPoint = typeof PolicyPoint.Type

export const PolicyEffect = Schema.Literal("allow", "deny", "require_approval")
export type PolicyEffect = typeof PolicyEffect.Type

/**
 * What a rule looks at. Every condition is optional; a rule with none matches everything, which is
 * legal and is exactly what the vacuous-rule report is for (ADR-014).
 */
export class PolicyCondition extends Schema.Class<PolicyCondition>("PolicyCondition")({
  /** Restrict the rule to one evaluation point. */
  at: Schema.optional(PolicyPoint),
  /** Gears this rule applies to. */
  autonomy: Schema.optional(Schema.Array(Autonomy)),
  /** Capability id globs, e.g. `agent.*` or `research.search@0.1`. */
  capabilities: Schema.optional(Schema.Array(Schema.NonEmptyTrimmedString)),
  /** Scopes the tool is requesting. */
  scopes: Schema.optional(Schema.Array(Schema.NonEmptyTrimmedString)),
  /** Tags carried by the inputs — this is how `untrusted` content reaches policy. */
  tags: Schema.optional(Schema.Array(Schema.NonEmptyTrimmedString)),
  /** Fires when estimated cost is at least this many dollars. */
  minDollars: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  /** Fires when estimated duration is at least this many seconds. */
  minSeconds: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  /** Fires when the tool declares itself non-idempotent (ADR-016). */
  nonIdempotent: Schema.optional(Schema.Boolean)
}) {}

export class PolicyRule extends Schema.Class<PolicyRule>("PolicyRule")({
  id: PolicyRuleId,
  description: LongText,
  /**
   * Lower numbers win. Ties are broken by `deny` over `require_approval` over `allow`, so a
   * misordered policy fails safe rather than silently permitting.
   */
  priority: Schema.Int.pipe(Schema.nonNegative()),
  effect: PolicyEffect,
  when: PolicyCondition
}) {}

export class Policy extends Schema.Class<Policy>("Policy")({
  version: Schema.NonEmptyTrimmedString,
  rules: Schema.Array(PolicyRule),
  /**
   * What happens when no rule matches. Defaults to `allow` — but every unmatched evaluation is
   * still recorded as unmatched, which is the number ADR-014 wants reported. A default of `deny`
   * is available for the day coverage is good enough to close the world.
   */
  defaultEffect: Schema.optionalWith(PolicyEffect, { default: () => "allow" as const })
}) {}

/** The request a decision is made about. */
export class PolicyRequest extends Schema.Class<PolicyRequest>("PolicyRequest")({
  at: PolicyPoint,
  actor: Actor,
  autonomy: Autonomy,
  capability: Schema.optional(CapabilityId),
  scopes: Schema.optionalWith(Schema.Array(Schema.NonEmptyTrimmedString), { default: () => [] }),
  tags: Schema.optionalWith(Schema.Array(Schema.NonEmptyTrimmedString), { default: () => [] }),
  estimatedDollars: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  estimatedSeconds: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  idempotent: Schema.optional(Schema.Boolean)
}) {}

/**
 * Why a decision came out the way it did.
 *
 * A tagged union rather than a nullable rule id: `unmatched` is a first-class outcome that has to
 * be counted, and making it a `null` would let it be read as "no information" instead of "nothing
 * governed this".
 */
export const PolicyBasis = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("matched"), ruleId: PolicyRuleId }),
  Schema.Struct({ _tag: Schema.Literal("unmatched") })
)
export type PolicyBasis = typeof PolicyBasis.Type

export class PolicyDecision extends Schema.Class<PolicyDecision>("PolicyDecision")({
  at: PolicyPoint,
  effect: PolicyEffect,
  /** Required. See the note at the top of this file. */
  basis: PolicyBasis,
  policyVersion: Schema.NonEmptyTrimmedString,
  /** Every rule that matched, highest priority first — kept so dead and vacuous rules are visible. */
  consideredRuleIds: Schema.Array(PolicyRuleId),
  ts: EpochSeconds,
  correlationId: Schema.optional(Uuid7)
}) {}
