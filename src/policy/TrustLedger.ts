/**
 * The trust ledger (ADR-014).
 *
 * Reports a skill's standing and answers whether a gear is permitted. The promotion rules live
 * here: both ledgers must clear a gear's score, and each must rest on the gear's minimum number of
 * signals. `make` answers over fixed records; `TrustUpdater.ledgerFromLog` answers from the event
 * log at the moment it is asked, which is what `pnpm start` runs.
 */

import { Context, Effect, Layer } from "effect"

import type { Autonomy, EpochSeconds } from "../domain/Common.js"
import type { Score, SkillId, TrustPolicy } from "../domain/Trust.js"
import { TrustRecord } from "../domain/Trust.js"

const GEAR_ORDER: ReadonlyArray<Autonomy> = ["S0", "S1", "S2", "S3", "S4"]

export const gearRank = (gear: Autonomy): number => GEAR_ORDER.indexOf(gear)

/**
 * Exponential decay to a half-life.
 *
 * Trust that is not re-earned fades. A score sitting at 0.9 because a skill did well six months ago
 * is a claim about the past being used to justify autonomy in the present.
 */
export const decayed = (score: number, elapsedSeconds: number, halfLifeSeconds: number): number => {
  if (elapsedSeconds <= 0) return score
  return score * Math.pow(0.5, elapsedSeconds / halfLifeSeconds)
}

/** A record's scores as of `now`, with decay applied. Does not mutate anything. */
export const asOf = (record: TrustRecord, policy: TrustPolicy, now: EpochSeconds): TrustRecord => {
  const elapsed = Math.max(0, now - record.updatedAt)
  return new TrustRecord({
    skill: record.skill,
    competence: decayed(record.competence, elapsed, policy.decay.competenceHalfLifeSeconds) as Score,
    compliance: decayed(record.compliance, elapsed, policy.decay.complianceHalfLifeSeconds) as Score,
    gear: record.gear,
    updatedAt: now,
    // Decay ages the scores, not the evidence: the signals were still observed.
    competenceSignals: record.competenceSignals,
    complianceSignals: record.complianceSignals
  })
}

export interface GearVerdict {
  readonly permitted: boolean
  /** Which ledger blocked it — the useful half of the answer. */
  readonly blockedBy: ReadonlyArray<"competence" | "compliance">
  readonly required: { readonly competence: number; readonly compliance: number; readonly signals: number }
  readonly actual: {
    readonly competence: number
    readonly compliance: number
    readonly competenceSignals: number
    readonly complianceSignals: number
  }
}

/**
 * Whether a skill may operate at a gear.
 *
 * **Both ledgers must clear.** A skill with perfect competence and weak compliance is refused, and
 * the verdict says which one failed so the refusal is explicable rather than mysterious.
 *
 * A gear with no threshold configured is permitted — the thresholds describe what must be *earned*,
 * and S0 (advise only, no side effects) is deliberately not something to earn.
 */
export const permits = (
  record: TrustRecord,
  policy: TrustPolicy,
  gear: Autonomy,
  now: EpochSeconds
): GearVerdict => {
  const current = asOf(record, policy, now)
  const threshold = policy.thresholds.find((entry) => entry.gear === gear)

  const required = {
    competence: threshold?.minCompetence ?? 0,
    compliance: threshold?.minCompliance ?? 0,
    signals: threshold?.minSignals ?? 0
  }
  const actual = {
    competence: current.competence,
    compliance: current.compliance,
    competenceSignals: record.competenceSignals,
    complianceSignals: record.complianceSignals
  }

  // A ledger blocks when its score is too low or rests on too little evidence.
  const blockedBy: Array<"competence" | "compliance"> = []
  if (actual.competence < required.competence || actual.competenceSignals < required.signals) {
    blockedBy.push("competence")
  }
  if (actual.compliance < required.compliance || actual.complianceSignals < required.signals) {
    blockedBy.push("compliance")
  }

  return { permitted: blockedBy.length === 0, blockedBy, required, actual }
}

/** The highest gear a skill currently qualifies for. */
export const highestPermittedGear = (
  record: TrustRecord,
  policy: TrustPolicy,
  now: EpochSeconds
): Autonomy => {
  let best: Autonomy = "S0"
  for (const gear of GEAR_ORDER) {
    if (permits(record, policy, gear, now).permitted) best = gear
    else break
  }
  return best
}

export class TrustLedger extends Context.Tag("policy/TrustLedger")<TrustLedger, {
  readonly get: (skill: SkillId) => Effect.Effect<TrustRecord>
  readonly permits: (skill: SkillId, gear: Autonomy) => Effect.Effect<GearVerdict>
  readonly policy: Effect.Effect<TrustPolicy>
}>() {}

/**
 * A ledger over a fixed set of records.
 *
 * An unknown skill starts at zero on both ledgers and S0 — nothing is trusted until it has earned
 * something, which is the only safe default for a system whose autonomy is meant to be earned.
 */
export const make = (policy: TrustPolicy, records: ReadonlyArray<TrustRecord>) => {
  const bySkill = new Map(records.map((record) => [record.skill, record]))

  const unknown = (skill: SkillId): TrustRecord =>
    new TrustRecord({
      skill,
      competence: 0 as Score,
      compliance: 0 as Score,
      gear: "S0",
      updatedAt: 0 as EpochSeconds
    })

  const now = Effect.map(
    Effect.clockWith((clock) => clock.currentTimeMillis),
    (millis) => Math.floor(millis / 1000) as EpochSeconds
  )

  return TrustLedger.of({
    get: (skill) => Effect.map(now, (ts) => asOf(bySkill.get(skill) ?? unknown(skill), policy, ts)),
    permits: (skill, gear) => Effect.map(now, (ts) => permits(bySkill.get(skill) ?? unknown(skill), policy, gear, ts)),
    policy: Effect.succeed(policy)
  })
}

export const layer = (policy: TrustPolicy, records: ReadonlyArray<TrustRecord>) =>
  Layer.succeed(TrustLedger, make(policy, records))
