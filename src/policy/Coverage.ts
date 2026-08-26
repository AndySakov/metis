/**
 * Policy coverage (ADR-014 §2).
 *
 * This answers the question the system could not previously answer: *did any rule have an opinion
 * about what just happened?* It is computed from the event log rather than from counters kept
 * alongside the engine, so the number is derived from the same tamper-evident record an auditor
 * would read, and cannot drift from it.
 *
 * Three quantities, each of which is uncomfortable on purpose:
 *
 * - **Unmatched fraction** — the share of evaluations where no rule engaged. This is the honest
 *   measure of ungoverned behaviour, and it will be high at first. Resist writing rules purely to
 *   move it: a rule that fires on everything improves coverage and constrains nothing, which is
 *   why vacuous rules are tracked too.
 * - **Dead rules** — never fired. Either the risk never materialised or the rule does not work.
 *   Both need investigation; they are not the same finding.
 * - **Vacuous rules** — fired on effectively everything, and therefore constrain nothing.
 *
 * The external evidence ADR-014 cites is worth keeping in mind here: a fixed set of rules has a
 * hard ceiling on what it can catch, and re-deriving rules from the failures they missed does not
 * raise it. Coverage is a property to be *measured*, not a target to be reached.
 */

import { Effect } from "effect"

import type { EpochSeconds } from "../domain/Common.js"
import type { Policy, PolicyPoint, PolicyRuleId } from "../domain/Policy.js"
import { EventLogStore } from "../mneme/EventLogStore.js"
import { POLICY_EVALUATED } from "./PolicyGate.js"

export interface RuleActivity {
  readonly ruleId: PolicyRuleId
  /** Evaluations where this rule matched, whether or not it won. */
  readonly consideredCount: number
  /** Evaluations this rule decided. */
  readonly decidedCount: number
}

export interface CoverageReport {
  readonly evaluations: number
  readonly unmatched: number
  /** In [0,1]. Zero evaluations reports 0 rather than dividing by zero — and `evaluations` says so. */
  readonly unmatchedFraction: number
  readonly byPoint: Readonly<Record<PolicyPoint, { evaluations: number; unmatched: number }>>
  readonly rules: ReadonlyArray<RuleActivity>
  /** Rules in the policy that never appeared in any evaluation. */
  readonly deadRules: ReadonlyArray<PolicyRuleId>
  /**
   * Rules that matched at least `vacuousThreshold` of all evaluations. A rule that matches
   * everything is not governing anything.
   */
  readonly vacuousRules: ReadonlyArray<PolicyRuleId>
}

const POINTS: ReadonlyArray<PolicyPoint> = ["plan_validation", "tool_dispatch", "artifact_write"]

interface EvaluationPayload {
  readonly at: PolicyPoint
  readonly basis: { _tag: "matched"; ruleId: PolicyRuleId } | { _tag: "unmatched" }
  readonly consideredRuleIds: ReadonlyArray<PolicyRuleId>
}

/** Narrow an event payload to an evaluation, tolerating anything malformed by ignoring it. */
const asEvaluation = (payload: unknown): EvaluationPayload | undefined => {
  if (payload === null || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  const basis = record.basis as EvaluationPayload["basis"] | undefined
  if (basis === undefined || typeof basis._tag !== "string") return undefined
  if (!POINTS.includes(record.at as PolicyPoint)) return undefined
  return {
    at: record.at as PolicyPoint,
    basis,
    consideredRuleIds: Array.isArray(record.consideredRuleIds)
      ? (record.consideredRuleIds as Array<PolicyRuleId>)
      : []
  }
}

export interface CoverageWindow {
  readonly fromTs?: EpochSeconds
  readonly toTs?: EpochSeconds
  /** Share of evaluations a rule must match to count as vacuous. Defaults to 0.95. */
  readonly vacuousThreshold?: number
}

export const report = (
  policy: Policy,
  window: CoverageWindow = {}
): Effect.Effect<CoverageReport, never, EventLogStore> =>
  Effect.gen(function*() {
    const log = yield* EventLogStore

    const events = yield* Effect.orDie(
      log.read({
        types: [POLICY_EVALUATED],
        ...(window.fromTs !== undefined ? { fromTs: window.fromTs } : {}),
        ...(window.toTs !== undefined ? { toTs: window.toTs } : {})
      })
    )

    const evaluations = events.map((event) => asEvaluation(event.payload)).filter(
      (value): value is EvaluationPayload => value !== undefined
    )

    const byPoint = Object.fromEntries(
      POINTS.map((point) => [point, { evaluations: 0, unmatched: 0 }])
    ) as Record<PolicyPoint, { evaluations: number; unmatched: number }>

    const considered = new Map<PolicyRuleId, number>()
    const decided = new Map<PolicyRuleId, number>()
    let unmatched = 0

    for (const evaluation of evaluations) {
      byPoint[evaluation.at].evaluations++

      if (evaluation.basis._tag === "unmatched") {
        unmatched++
        byPoint[evaluation.at].unmatched++
      } else {
        const ruleId = evaluation.basis.ruleId
        decided.set(ruleId, (decided.get(ruleId) ?? 0) + 1)
      }

      // Deduplicated: a rule appearing twice in one evaluation is still one evaluation it matched.
      for (const ruleId of new Set(evaluation.consideredRuleIds)) {
        considered.set(ruleId, (considered.get(ruleId) ?? 0) + 1)
      }
    }

    const total = evaluations.length
    const threshold = window.vacuousThreshold ?? 0.95

    const rules: Array<RuleActivity> = policy.rules.map((rule) => ({
      ruleId: rule.id,
      consideredCount: considered.get(rule.id) ?? 0,
      decidedCount: decided.get(rule.id) ?? 0
    }))

    return {
      evaluations: total,
      unmatched,
      unmatchedFraction: total === 0 ? 0 : unmatched / total,
      byPoint,
      rules,
      deadRules: rules.filter((rule) => rule.consideredCount === 0).map((rule) => rule.ruleId),
      // A rule cannot be judged vacuous on no evidence, so an empty window reports none.
      vacuousRules: total === 0
        ? []
        : rules.filter((rule) => rule.consideredCount / total >= threshold).map((rule) => rule.ruleId)
    }
  })
