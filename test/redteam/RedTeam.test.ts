import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import type { EpochSeconds } from "../../src/domain/Common.js"
import { Policy, PolicyRequest } from "../../src/domain/Policy.js"
import { decide } from "../../src/policy/PolicyEngine.js"

/**
 * The red-team suite (ADR-014 §5, REBUILD-PLAN Stage 5).
 *
 * The output is a number: how many attempts got through, and of those that were stopped, how many
 * were stopped **by a rule** versus **by luck**. That second split is the whole point. An attempt
 * blocked because a rule denied it is evidence the constraints work; an attempt that merely failed
 * to be allowed, with no rule engaged, is evidence of nothing — and if the two were summed the
 * report would look identical in both cases.
 *
 * This suite is deliberately not exhaustive and cannot be. Rules only catch what they were written
 * for, and one attempt here is expected to get through precisely so the number stays honest.
 */

const vector = JSON.parse(
  readFileSync(resolve(__dirname, "../../specs/redteam/attempts.json"), "utf8")
) as {
  policy: unknown
  attempts: Array<{
    name: string
    request: Record<string, unknown>
    mustNotBe: string
    expectedToGetThrough?: boolean
  }>
}

const policy = Schema.decodeUnknownSync(Policy)(vector.policy)
const decodeRequest = Schema.decodeUnknownSync(PolicyRequest)

interface Outcome {
  readonly name: string
  readonly effect: string
  readonly stopped: boolean
  /** Stopped *and* a rule said so. The only outcome that counts as the policy working. */
  readonly stoppedByRule: boolean
  readonly expectedToGetThrough: boolean
}

const outcomes: Array<Outcome> = vector.attempts.map((attempt) => {
  const decision = decide(policy, decodeRequest(attempt.request), 0 as EpochSeconds)
  const stopped = decision.effect !== attempt.mustNotBe
  return {
    name: attempt.name,
    effect: decision.effect,
    stopped,
    stoppedByRule: stopped && decision.basis._tag === "matched",
    expectedToGetThrough: attempt.expectedToGetThrough === true
  }
})

describe("red team", () => {
  for (const attempt of vector.attempts) {
    const outcome = outcomes.find((o) => o.name === attempt.name)!

    if (attempt.expectedToGetThrough === true) {
      it(`[known gap] ${attempt.name}`, () => {
        // Asserted as a gap so that closing it is a deliberate, visible change rather than a
        // silent improvement nobody reviewed.
        expect(outcome.stopped, "this attempt is documented as getting through").toBe(false)
      })
      continue
    }

    it(attempt.name, () => {
      expect(outcome.effect, `must not be ${attempt.mustNotBe}`).not.toBe(attempt.mustNotBe)
      // Stopped is not enough — it has to be stopped *for a reason*.
      expect(outcome.stoppedByRule, "must be stopped by a matching rule, not by luck").toBe(true)
    })
  }
})

describe("the red-team number", () => {
  const total = outcomes.length
  const gotThrough = outcomes.filter((o) => !o.stopped)
  const byRule = outcomes.filter((o) => o.stoppedByRule)
  const byLuck = outcomes.filter((o) => o.stopped && !o.stoppedByRule)

  it("is reported, not assumed", () => {
    // Printed so a policy change that does not move these numbers is visibly inert.
    console.log(
      [
        "",
        "  red-team results",
        `    attempts:        ${total}`,
        `    got through:     ${gotThrough.length}` +
        (gotThrough.length > 0 ? `  (${gotThrough.map((o) => o.name).join("; ")})` : ""),
        `    caught by rule:  ${byRule.length}`,
        `    caught by luck:  ${byLuck.length}`,
        ""
      ].join("\n")
    )

    expect(total).toBeGreaterThan(0)
    expect(byRule.length + byLuck.length + gotThrough.length).toBe(total)
  })

  it("counts no block as luck — every stop is attributable to a rule", () => {
    // If this ever fails, something is being blocked by an accident of the engine rather than by
    // policy, and the coverage story is weaker than it looks.
    expect(byLuck.map((o) => o.name)).toEqual([])
  })

  it("records exactly the gaps that are documented as gaps", () => {
    expect(gotThrough.map((o) => o.name).sort()).toEqual(
      outcomes.filter((o) => o.expectedToGetThrough).map((o) => o.name).sort()
    )
  })
})
