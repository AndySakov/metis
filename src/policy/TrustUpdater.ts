/**
 * Deriving the trust ledgers from the event log (ADR-014 §3).
 *
 * The scores are *derived*, not accumulated in place. Reading them out of the same tamper-evident
 * record an auditor would read means a score cannot drift from the evidence for it, and a
 * disagreement between "what the ledger says" and "what actually happened" is not representable.
 *
 * The two ledgers move on disjoint evidence, which is the entire point:
 *
 * - **Competence** rises when METIS does the job well — tools completing, approvals granted rather
 *   than withheld. It falls on failure.
 * - **Compliance** rises only on *safety* evidence: policy evaluations survived, gates cleared
 *   without override. It falls hard on a denial.
 *
 * Nothing that raises competence can raise compliance. A skill that writes beautifully and trips a
 * red line repeatedly must end up untrusted, and that only works if the good work is invisible to
 * the compliance ledger.
 */

import { Effect } from "effect"

import type { Actor, Autonomy, EpochSeconds } from "../domain/Common.js"
import type { EventId, EventType } from "../domain/Event.js"
import { Event } from "../domain/Event.js"
import { uuidv7 } from "../domain/Ids.js"
import type { Score, SkillId, TrustPolicy } from "../domain/Trust.js"
import { TrustRecord } from "../domain/Trust.js"
import { EventLogStore } from "../mneme/EventLogStore.js"
import { gearRank, highestPermittedGear } from "./TrustLedger.js"

/**
 * The floor a compliance event drops the ledger to.
 *
 * ADR-014: "Demotion on a compliance event is immediate and does not wait for decay." Averaging a
 * denial into a history of good behaviour would let a skill with a long record absorb violations
 * without moving, which is the opposite of the intent — so a denial overrides the average outright.
 */
const COMPLIANCE_FLOOR = 0.1

/** Evidence extracted from one event, if it carries any. */
interface Signal {
  readonly skill: SkillId
  readonly ledger: "competence" | "compliance"
  readonly kind: "positive" | "negative" | "redline"
}

/** `research.search@0.1` → `research.search`. Trust is tracked per skill, not per version. */
export const skillOf = (capability: string): SkillId => capability.split("@")[0] as SkillId

const payloadCapability = (event: Event): string | undefined => {
  if (event.payload === null || typeof event.payload !== "object") return undefined
  const capability = (event.payload as { capability?: unknown }).capability
  return typeof capability === "string" ? capability : undefined
}

export const signalsFrom = (event: Event): ReadonlyArray<Signal> => {
  const capability = payloadCapability(event)
  if (capability === undefined) return []
  const skill = skillOf(capability)

  switch (event.type as string) {
    case "TOOL_COMPLETED":
      return [{ skill, ledger: "competence", kind: "positive" }]
    case "STEP_FAILED":
      return [{ skill, ledger: "competence", kind: "negative" }]
    case "APPROVAL_GRANTED":
      // A human said yes. That is acceptance of the work, not evidence about safety.
      return [{ skill, ledger: "competence", kind: "positive" }]

    case "POLICY_EVALUATED": {
      const effect = (event.payload as { effect?: unknown }).effect
      if (effect === "deny") return [{ skill, ledger: "compliance", kind: "redline" }]
      // Surviving an evaluation is compliance evidence. `require_approval` is not a violation —
      // the gate worked — but it is weaker evidence than a clean allow, so it counts as neutral.
      if (effect === "allow") return [{ skill, ledger: "compliance", kind: "positive" }]
      return []
    }

    case "STEP_DENIED":
    case "ARTIFACT_WRITE_DENIED":
      return [{ skill, ledger: "compliance", kind: "redline" }]

    case "VERIFICATION_SAMPLED": {
      // ADR-014 §4: sample results feed the compliance ledger — the "verified-clean rate on
      // audited samples" it lists as compliance evidence.
      //
      // A failed sample is *negative* evidence but deliberately not a red line. The distinction is
      // real: a red line means the skill attempted something forbidden, while a failed sample means
      // its output did not match the contract it declared. The first is a safety violation and
      // demotes immediately; the second is a correctness problem that should drag the ledger down
      // over repeated occurrences without one schema mismatch collapsing a skill to S0.
      const clean = (event.payload as { clean?: unknown }).clean
      if (typeof clean !== "boolean") return []
      return [{ skill, ledger: "compliance", kind: clean ? "positive" : "negative" }]
    }

    default:
      return []
  }
}

export interface DerivedTrust {
  readonly record: TrustRecord
  readonly competenceSignals: number
  readonly complianceSignals: number
  readonly redlines: number
}

/**
 * Derive a skill's standing from a list of events.
 *
 * A skill with no evidence scores zero on both ledgers — untrusted until something is earned,
 * which is the only safe default for a system whose autonomy is supposed to be earned rather than
 * assumed.
 */
export const derive = (
  events: ReadonlyArray<Event>,
  skill: SkillId,
  policy: TrustPolicy,
  now: EpochSeconds
): DerivedTrust => {
  let competencePositive = 0
  let competenceTotal = 0
  let compliancePositive = 0
  let complianceTotal = 0
  let redlines = 0

  for (const event of events) {
    for (const signal of signalsFrom(event)) {
      if (signal.skill !== skill) continue

      if (signal.ledger === "competence") {
        competenceTotal++
        if (signal.kind === "positive") competencePositive++
      } else {
        complianceTotal++
        if (signal.kind === "positive") compliancePositive++
        if (signal.kind === "redline") redlines++
      }
    }
  }

  const competence = (competenceTotal === 0 ? 0 : competencePositive / competenceTotal) as Score
  const compliance = (redlines > 0
    ? COMPLIANCE_FLOOR
    : complianceTotal === 0
    ? 0
    : compliancePositive / complianceTotal) as Score

  const record = new TrustRecord({ skill, competence, compliance, gear: "S0", updatedAt: now })

  // The gear a skill holds is a consequence of its ledgers, never set independently.
  return {
    record: new TrustRecord({ ...record, gear: highestPermittedGear(record, policy, now) }),
    competenceSignals: competenceTotal,
    complianceSignals: complianceTotal,
    redlines
  }
}

/** Derive a skill's standing from the whole event log. */
export const deriveFromLog = (
  skill: SkillId,
  policy: TrustPolicy
): Effect.Effect<DerivedTrust, never, EventLogStore> =>
  Effect.gen(function*() {
    const log = yield* EventLogStore
    const events = yield* Effect.orDie(log.read({}))
    const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    return derive(events, skill, policy, Math.floor(millis / 1000) as EpochSeconds)
  })

/**
 * Recompute a skill's standing and record any gear change.
 *
 * ADR-014: "Any promotion or demotion is an event in the log with its justification attached."
 * Without the event the ramp is unauditable — you could see what gear a skill holds today but not
 * when it got there, on what evidence, or how many times it has been demoted and re-promoted.
 *
 * Emitting the justification alongside the gear also makes a demotion explicable at the moment it
 * happens, rather than requiring someone to re-derive the scores from the log to find out why.
 */
export const reconcile = (
  skill: SkillId,
  previousGear: Autonomy,
  policy: TrustPolicy
): Effect.Effect<DerivedTrust, never, EventLogStore> =>
  Effect.gen(function*() {
    const log = yield* EventLogStore
    const derived = yield* deriveFromLog(skill, policy)
    const gear = derived.record.gear

    if (gear === previousGear) return derived

    const promoted = gearRank(gear) > gearRank(previousGear)
    const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

    yield* Effect.orDie(
      log.append(
        new Event({
          id: uuidv7(millis) as EventId,
          ts: Math.floor(millis / 1000) as EpochSeconds,
          type: (promoted ? "TRUST_PROMOTED" : "TRUST_DEMOTED") as EventType,
          actor: "metis" as Actor,
          payload: {
            skill,
            from: previousGear,
            to: gear,
            competence: derived.record.competence,
            compliance: derived.record.compliance,
            // The justification: which ledger moved, and on how much evidence.
            redlines: derived.redlines,
            competenceSignals: derived.competenceSignals,
            complianceSignals: derived.complianceSignals,
            reason: promoted
              ? "both ledgers cleared the threshold for the higher gear"
              : derived.redlines > 0
              ? "compliance event — immediate demotion, not decay"
              : "a ledger fell below the threshold for the previous gear"
          }
        })
      )
    )

    return derived
  })
