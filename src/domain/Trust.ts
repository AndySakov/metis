/**
 * The two-ledger trust model (ADR-014).
 *
 * The design exists to fix a specific failure in the original: trust was promoted on "low edit
 * ratio, high success" — that is, on METIS being *useful*. A skill that drafts excellent documents
 * would have ratcheted toward scheduled autonomy on the strength of its prose, with no evidence
 * whatsoever that its constraints hold.
 *
 * So there are two scores, and they move for different reasons. Competence cannot substitute for
 * compliance at any price.
 */

import { Schema } from "effect"

import { Autonomy, EpochSeconds } from "./Common.js"

/** A skill is what trust is tracked against — a capability family, not an individual tool. */
export const SkillId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9_.-]*$/),
  Schema.annotations({ examples: ["research.search", "design.prd"] }),
  Schema.brand("SkillId"),
  Schema.annotations({ identifier: "SkillId" })
)
export type SkillId = typeof SkillId.Type

/** A score in [0,1]. */
export const Score = Schema.Number.pipe(
  Schema.between(0, 1),
  Schema.brand("Score"),
  Schema.annotations({ identifier: "Score" })
)
export type Score = typeof Score.Type

/**
 * Half-lives are recorded in policy rather than described as "decays over time" (ADR-014).
 *
 * Stated in seconds so decay is computable from two timestamps and nothing else.
 */
export class TrustDecay extends Schema.Class<TrustDecay>("TrustDecay")({
  competenceHalfLifeSeconds: Schema.Positive,
  complianceHalfLifeSeconds: Schema.Positive
}) {}

/**
 * Thresholds a skill must clear to hold a gear.
 *
 * Both ledgers are required. This is the rule the whole ADR turns on.
 */
export class GearThreshold extends Schema.Class<GearThreshold>("GearThreshold")({
  gear: Autonomy,
  minCompetence: Score,
  minCompliance: Score
}) {}

export class TrustPolicy extends Schema.Class<TrustPolicy>("TrustPolicy")({
  decay: TrustDecay,
  thresholds: Schema.Array(GearThreshold)
}) {}

/**
 * A skill's standing.
 *
 * `updatedAt` is when the scores were last recomputed; decay is applied relative to it rather than
 * being written back on a timer, so a ledger nobody has touched still reads correctly.
 */
export class TrustRecord extends Schema.Class<TrustRecord>("TrustRecord")({
  skill: SkillId,
  /** Task success, edit ratio, acceptance. Rises when METIS does the job well. */
  competence: Score,
  /** Policy evaluations survived, gates cleared without override, verified-clean samples. */
  compliance: Score,
  gear: Autonomy,
  updatedAt: EpochSeconds
}) {}
