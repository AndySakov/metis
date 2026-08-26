import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import type { EpochSeconds } from "../../src/domain/Common.js"
import { Event } from "../../src/domain/Event.js"
import { uuidv7 } from "../../src/domain/Ids.js"
import type { SkillId } from "../../src/domain/Trust.js"
import { TrustPolicy } from "../../src/domain/Trust.js"
import { EventLogStore } from "../../src/mneme/EventLogStore.js"
import * as InMemoryEventLogStore from "../../src/mneme/InMemoryEventLogStore.js"
import { derive, reconcile, skillOf } from "../../src/policy/TrustUpdater.js"

/**
 * ADR-014's claim under test: competence and compliance move on disjoint evidence, and no amount
 * of good work can restore trust that a violation destroyed.
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

const SKILL = "design.prd" as SkillId
const CAPABILITY = "design.prd@1.0"

const event = (type: string, payload: Record<string, unknown>): Event =>
  Schema.decodeUnknownSync(Event)({
    id: uuidv7(),
    ts: 1_700_000_000,
    type,
    actor: "metis",
    payload: { capability: CAPABILITY, ...payload }
  })

const completed = () => event("TOOL_COMPLETED", {})
const failed = () => event("STEP_FAILED", {})
const cleanEvaluation = () => event("POLICY_EVALUATED", { effect: "allow" })
const denial = () => event("POLICY_EVALUATED", { effect: "deny" })

const at = (events: ReadonlyArray<Event>) => derive(events, SKILL, policy, 1_700_000_000 as EpochSeconds)

describe("trust is derived from the log", () => {
  it("a skill with no history is untrusted, not absent", () => {
    const { record } = at([])
    expect(record.competence).toBe(0)
    expect(record.compliance).toBe(0)
    expect(record.gear).toBe("S0")
  })

  it("competence rises on completed work", () => {
    const { record } = at([completed(), completed(), completed()])
    expect(record.competence).toBe(1)
  })

  it("competence falls on failures", () => {
    const { record } = at([completed(), completed(), failed(), failed()])
    expect(record.competence).toBe(0.5)
  })

  it("compliance rises only on clean policy evaluations", () => {
    const { record } = at([cleanEvaluation(), cleanEvaluation()])
    expect(record.compliance).toBe(1)
    // Nothing here was about doing the job, so competence stays at zero.
    expect(record.competence).toBe(0)
  })

  it("tracks a skill separately from others", () => {
    const other = Schema.decodeUnknownSync(Event)({
      id: uuidv7(),
      ts: 1_700_000_000,
      type: "TOOL_COMPLETED",
      actor: "metis",
      payload: { capability: "research.search@0.1" }
    })
    const { record } = at([completed(), other])
    expect(record.competence).toBe(1)
    expect(at([other]).record.competence).toBe(0)
  })

  it("treats versions of a capability as one skill", () => {
    expect(skillOf("design.prd@1.0")).toBe("design.prd")
    expect(skillOf("design.prd@2.0")).toBe("design.prd")
  })
})

describe("the two ledgers cannot substitute for each other", () => {
  it("excellent work does not raise compliance at all", () => {
    const { record } = at(Array.from({ length: 50 }, () => completed()))

    expect(record.competence).toBe(1)
    // This is the failure ADR-014 was written to prevent: fifty successes and still no evidence
    // that any constraint held.
    expect(record.compliance).toBe(0)
    expect(record.gear).toBe("S0")
  })

  it("a single denial demotes immediately, whatever the history", () => {
    const spotless = Array.from({ length: 100 }, () => cleanEvaluation())
    expect(at(spotless).record.compliance).toBe(1)
    expect(at([...spotless, ...Array.from({ length: 100 }, () => completed())]).record.gear).toBe("S4")

    // One violation, after a hundred clean evaluations.
    const withViolation = at([
      ...spotless,
      ...Array.from({ length: 100 }, () => completed()),
      denial()
    ])

    // Not averaged away — the ledger drops to the floor and the gear collapses with it.
    expect(withViolation.record.compliance).toBeLessThan(0.2)
    expect(withViolation.record.gear).toBe("S0")
    // Competence is untouched: it was still good work. That separation is the point.
    expect(withViolation.record.competence).toBe(1)
  })

  it("more good work after a violation does not restore trust", () => {
    const after = at([
      denial(),
      ...Array.from({ length: 500 }, () => completed()),
      ...Array.from({ length: 500 }, () => cleanEvaluation())
    ])

    expect(after.record.competence).toBe(1)
    expect(after.record.compliance).toBeLessThan(0.2)
    expect(after.record.gear).toBe("S0")
  })

  it("counts red lines so a demotion can be explained", () => {
    const result = at([cleanEvaluation(), denial(), denial()])
    expect(result.redlines).toBe(2)
    expect(result.complianceSignals).toBe(3)
  })
})

describe("the gear follows the ledgers", () => {
  it("is never set independently of the scores", () => {
    // Enough of both to clear S2 but not S3 (needs 0.8 compliance).
    const events = [
      ...Array.from({ length: 3 }, () => completed()),
      failed(),
      ...Array.from({ length: 3 }, () => cleanEvaluation()),
      event("POLICY_EVALUATED", { effect: "require_approval" })
    ]
    const { record } = at(events)

    expect(record.competence).toBeCloseTo(0.75, 10)
    expect(record.compliance).toBe(1)
    // Competence caps it at S3 (0.7) but not S4 (0.8).
    expect(record.gear).toBe("S3")
  })

  it("a require_approval evaluation is not a violation", () => {
    const { record } = at([event("POLICY_EVALUATED", { effect: "require_approval" })])
    // The gate worked. It is not positive compliance evidence either, so the ledger stays at zero
    // rather than being punished.
    expect(record.compliance).toBe(0)
    expect(at([event("POLICY_EVALUATED", { effect: "require_approval" })]).redlines).toBe(0)
  })
})

describe("a gear change is an event with its justification (ADR-014)", () => {
  const stack = InMemoryEventLogStore.layer

  const withLog = <A>(events: ReadonlyArray<Event>, effect: Effect.Effect<A, never, EventLogStore>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const log = yield* EventLogStore
        for (const e of events) yield* Effect.orDie(log.append(e))
        return yield* effect
      }).pipe(Effect.provide(stack)) as Effect.Effect<A>
    )

  it("emits TRUST_PROMOTED when both ledgers clear a higher gear", async () => {
    const history = [
      ...Array.from({ length: 10 }, () => completed()),
      ...Array.from({ length: 10 }, () => cleanEvaluation())
    ]

    const emitted = await withLog(
      history,
      Effect.gen(function*() {
        yield* reconcile(SKILL, "S0", policy)
        const log = yield* EventLogStore
        const all = yield* Effect.orDie(log.read({}))
        return all.filter((e) => String(e.type).startsWith("TRUST_"))
      })
    )

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.type).toBe("TRUST_PROMOTED")
    const payload = emitted[0]!.payload as Record<string, unknown>
    expect(payload.from).toBe("S0")
    expect(payload.to).toBe("S4")
    expect(payload.reason).toContain("both ledgers")
  })

  it("emits TRUST_DEMOTED naming the compliance event as the cause", async () => {
    const history = [
      ...Array.from({ length: 10 }, () => completed()),
      ...Array.from({ length: 10 }, () => cleanEvaluation()),
      denial()
    ]

    const emitted = await withLog(
      history,
      Effect.gen(function*() {
        // The skill was at S4 before the violation.
        yield* reconcile(SKILL, "S4", policy)
        const log = yield* EventLogStore
        const all = yield* Effect.orDie(log.read({}))
        return all.filter((e) => String(e.type).startsWith("TRUST_"))
      })
    )

    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.type).toBe("TRUST_DEMOTED")
    const payload = emitted[0]!.payload as Record<string, unknown>
    expect(payload.to).toBe("S0")
    expect(payload.redlines).toBe(1)
    // The justification distinguishes an immediate compliance demotion from a gradual one.
    expect(payload.reason).toContain("immediate demotion")
  })

  it("stays silent when the gear has not moved", async () => {
    const emitted = await withLog(
      [completed()],
      Effect.gen(function*() {
        yield* reconcile(SKILL, "S0", policy)
        const log = yield* EventLogStore
        const all = yield* Effect.orDie(log.read({}))
        return all.filter((e) => String(e.type).startsWith("TRUST_"))
      })
    )
    // A ledger that logged on every recomputation would drown the audit trail in noise.
    expect(emitted).toHaveLength(0)
  })
})

describe("sample results feed the compliance ledger (ADR-014 §4)", () => {
  const sampled = (clean: boolean) => event("VERIFICATION_SAMPLED", { clean })

  it("a clean sample is compliance evidence", () => {
    const { record } = at([sampled(true), sampled(true)])
    expect(record.compliance).toBe(1)
    // It says nothing about whether the work was good.
    expect(record.competence).toBe(0)
  })

  it("a failed sample drags compliance down", () => {
    const { record } = at([sampled(true), sampled(true), sampled(false), sampled(false)])
    expect(record.compliance).toBe(0.5)
  })

  it("a failed sample is not a red line — it does not collapse the ledger", () => {
    // The distinction that matters: attempting something forbidden demotes immediately; returning
    // output that does not match your own contract is a correctness problem that accumulates.
    const failedSamples = at([...Array.from({ length: 9 }, () => sampled(true)), sampled(false)])
    expect(failedSamples.redlines).toBe(0)
    expect(failedSamples.record.compliance).toBeCloseTo(0.9, 10)

    const redLine = at([...Array.from({ length: 9 }, () => sampled(true)), denial()])
    expect(redLine.redlines).toBe(1)
    expect(redLine.record.compliance).toBeLessThan(0.2)
  })

  it("clean samples and clean policy evaluations both count", () => {
    const derived = at([sampled(true), cleanEvaluation()])
    expect(derived.record.compliance).toBe(1)
    expect(derived.complianceSignals).toBe(2)
  })

  it("ignores a sample event with no verdict", () => {
    const malformed = event("VERIFICATION_SAMPLED", {})
    expect(at([malformed]).complianceSignals).toBe(0)
  })
})
