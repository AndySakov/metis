import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import type { EpochSeconds } from "../../src/domain/Common.js"
import type { Score, SkillId } from "../../src/domain/Trust.js"
import { TrustPolicy, TrustRecord } from "../../src/domain/Trust.js"
import * as TrustLedger from "../../src/policy/TrustLedger.js"

/**
 * ADR-014's central claim is that competence and compliance move independently and that promotion
 * requires both. These tests exist to make that claim falsifiable — in particular the one about a
 * highly competent, poorly compliant skill, which is the exact failure the two-ledger design was
 * introduced to prevent.
 */

const DAY = 86_400

const policy = Schema.decodeUnknownSync(TrustPolicy)({
  decay: { competenceHalfLifeSeconds: 30 * DAY, complianceHalfLifeSeconds: 14 * DAY },
  thresholds: [
    { gear: "S1", minCompetence: 0.2, minCompliance: 0.2 },
    { gear: "S2", minCompetence: 0.5, minCompliance: 0.5 },
    { gear: "S3", minCompetence: 0.7, minCompliance: 0.8 },
    { gear: "S4", minCompetence: 0.8, minCompliance: 0.95 }
  ]
})

const record = (competence: number, compliance: number, updatedAt = 0): TrustRecord =>
  new TrustRecord({
    skill: "design.prd" as SkillId,
    competence: competence as Score,
    compliance: compliance as Score,
    gear: "S0",
    updatedAt: updatedAt as EpochSeconds
  })

describe("promotion requires both ledgers (ADR-014)", () => {
  it("refuses a highly competent but non-compliant skill", () => {
    // The motivating case: excellent at the job, no evidence the constraints hold.
    const verdict = TrustLedger.permits(record(0.99, 0.3), policy, "S3", 0 as EpochSeconds)

    expect(verdict.permitted).toBe(false)
    expect(verdict.blockedBy).toEqual(["compliance"])
  })

  it("refuses a compliant but incompetent skill", () => {
    const verdict = TrustLedger.permits(record(0.1, 0.99), policy, "S3", 0 as EpochSeconds)

    expect(verdict.permitted).toBe(false)
    expect(verdict.blockedBy).toEqual(["competence"])
  })

  it("permits only when both clear", () => {
    const verdict = TrustLedger.permits(record(0.75, 0.85), policy, "S3", 0 as EpochSeconds)
    expect(verdict.permitted).toBe(true)
    expect(verdict.blockedBy).toEqual([])
  })

  it("competence cannot compensate for compliance at any value", () => {
    // Sweep competence across its whole range against a fixed failing compliance.
    for (let competence = 0; competence <= 1.0001; competence += 0.05) {
      const verdict = TrustLedger.permits(record(Math.min(competence, 1), 0.79), policy, "S3", 0 as EpochSeconds)
      expect(verdict.permitted, `competence=${competence.toFixed(2)} must not unlock S3`).toBe(false)
    }
  })

  it("reports the highest gear a skill qualifies for", () => {
    expect(TrustLedger.highestPermittedGear(record(0.6, 0.6), policy, 0 as EpochSeconds)).toBe("S2")
    expect(TrustLedger.highestPermittedGear(record(0.99, 0.99), policy, 0 as EpochSeconds)).toBe("S4")
    expect(TrustLedger.highestPermittedGear(record(0, 0), policy, 0 as EpochSeconds)).toBe("S0")
  })
})

describe("decay has explicit half-lives, not vibes", () => {
  it("halves a score after exactly one half-life", () => {
    expect(TrustLedger.decayed(1, 30 * DAY, 30 * DAY)).toBeCloseTo(0.5, 10)
    expect(TrustLedger.decayed(1, 60 * DAY, 30 * DAY)).toBeCloseTo(0.25, 10)
  })

  it("compliance decays faster than competence", () => {
    // The half-lives differ deliberately: evidence that constraints held goes stale sooner than
    // evidence that the work was good.
    const aged = TrustLedger.asOf(record(0.8, 0.8), policy, (14 * DAY) as EpochSeconds)

    expect(aged.compliance).toBeCloseTo(0.4, 10)
    expect(aged.competence).toBeGreaterThan(aged.compliance)
  })

  it("decay can drop a skill below a threshold it previously cleared", () => {
    const fresh = record(0.9, 0.96)
    expect(TrustLedger.permits(fresh, policy, "S4", 0 as EpochSeconds).permitted).toBe(true)

    const stale = TrustLedger.permits(fresh, policy, "S4", (21 * DAY) as EpochSeconds)
    expect(stale.permitted).toBe(false)
    expect(stale.blockedBy).toContain("compliance")
  })
})

describe("the ledger as a service", () => {
  it("treats an unknown skill as untrusted rather than absent", async () => {
    const verdict = await Effect.runPromise(
      Effect.gen(function*() {
        const ledger = yield* TrustLedger.TrustLedger
        return yield* ledger.permits("never.seen" as SkillId, "S2")
      }).pipe(Effect.provide(TrustLedger.layer(policy, [])))
    )

    expect(verdict.permitted).toBe(false)
    expect(verdict.actual.competence).toBe(0)
    expect(verdict.actual.compliance).toBe(0)
  })

  it("S0 needs no threshold — advising is not something to earn", async () => {
    const verdict = await Effect.runPromise(
      Effect.gen(function*() {
        const ledger = yield* TrustLedger.TrustLedger
        return yield* ledger.permits("never.seen" as SkillId, "S0")
      }).pipe(Effect.provide(TrustLedger.layer(policy, [])))
    )

    expect(verdict.permitted).toBe(true)
  })
})
