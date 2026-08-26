import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import type { EpochSeconds } from "../../src/domain/Common.js"
import { Policy, PolicyRequest } from "../../src/domain/Policy.js"
import * as PolicyEngine from "../../src/policy/PolicyEngine.js"

/**
 * ADR-008 requires every policy to have unit tests with example inputs and expected decisions.
 * `CLAUDE.md` names their absence as a trap: "do not let policy become a config file with no
 * tests." These run the vectors in `specs/policy/conformance/`.
 */

const CONFORMANCE = resolve(__dirname, "../../specs/policy/conformance")

interface Case {
  readonly name: string
  readonly request: Record<string, unknown>
  readonly expect: {
    effect: string
    basis: string
    ruleId?: string
    consideredRuleIds?: ReadonlyArray<string>
  }
}

interface Vector {
  readonly name: string
  readonly policy: unknown
  readonly cases: ReadonlyArray<Case>
}

const vectors = readdirSync(CONFORMANCE)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(CONFORMANCE, file), "utf8")) as Vector)

const decodePolicy = Schema.decodeUnknownSync(Policy)
const decodeRequest = Schema.decodeUnknownSync(PolicyRequest)

describe("policy conformance vectors", () => {
  it("there are vectors to run", () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const vector of vectors) {
    describe(vector.name, () => {
      const policy = decodePolicy(vector.policy)

      for (const testCase of vector.cases) {
        it(testCase.name, () => {
          const decision = PolicyEngine.decide(policy, decodeRequest(testCase.request), 0 as EpochSeconds)

          expect(decision.effect, "effect").toBe(testCase.expect.effect)
          expect(decision.basis._tag, "basis").toBe(testCase.expect.basis)

          if (testCase.expect.ruleId !== undefined) {
            expect(decision.basis._tag).toBe("matched")
            expect((decision.basis as { ruleId: string }).ruleId, "ruleId").toBe(testCase.expect.ruleId)
          }

          if (testCase.expect.consideredRuleIds !== undefined) {
            expect(decision.consideredRuleIds, "consideredRuleIds").toEqual(testCase.expect.consideredRuleIds)
          }
        })
      }
    })
  }
})

describe("the decision always says why (ADR-014)", () => {
  const policy = decodePolicy(vectors[0]!.policy)

  it("records the policy version so a decision can be reproduced", () => {
    const decision = PolicyEngine.decide(
      policy,
      decodeRequest({ at: "artifact_write", actor: "metis", autonomy: "S1" }),
      0 as EpochSeconds
    )
    expect(decision.policyVersion).toBe("test-1")
  })

  it("an unmatched allow is distinguishable from a granted allow", () => {
    const ungoverned = PolicyEngine.decide(
      policy,
      decodeRequest({ at: "artifact_write", actor: "metis", autonomy: "S1" }),
      0 as EpochSeconds
    )
    const granted = PolicyEngine.decide(
      policy,
      decodeRequest({
        at: "tool_dispatch",
        actor: "metis",
        autonomy: "S1",
        capability: "research.summarize@0.1",
        idempotent: true
      }),
      0 as EpochSeconds
    )

    // Same effect...
    expect(ungoverned.effect).toBe("allow")
    expect(granted.effect).toBe("allow")
    // ...different basis. This is the whole point of ADR-014.
    expect(ungoverned.basis._tag).toBe("unmatched")
    expect(granted.basis._tag).toBe("matched")
  })

  it("keeps every matching rule, so vacuous rules are visible", () => {
    const decision = PolicyEngine.decide(
      policy,
      decodeRequest({
        at: "tool_dispatch",
        actor: "metis",
        autonomy: "S3",
        capability: "research.search@0.1",
        estimatedDollars: 12,
        idempotent: true
      }),
      0 as EpochSeconds
    )
    expect(decision.consideredRuleIds).toEqual(["approve.expensive", "allow.research_reads"])
  })
})

describe("the engine as a service", () => {
  it("evaluates through the Context.Tag", async () => {
    const policy = decodePolicy(vectors[0]!.policy)

    const decision = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* PolicyEngine.PolicyEngine
        return yield* engine.evaluate(
          decodeRequest({
            at: "tool_dispatch",
            actor: "metis",
            autonomy: "S2",
            capability: "agent.web_navigate@1.0",
            tags: ["untrusted"]
          })
        )
      }).pipe(Effect.provide(PolicyEngine.layer(policy)))
    )

    expect(decision.effect).toBe("deny")
    expect(decision.ts).toBeGreaterThan(0)
  })
})
