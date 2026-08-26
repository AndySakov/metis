import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"

import { Policy, PolicyRequest } from "../../src/domain/Policy.js"
import { EventLogStore } from "../../src/mneme/EventLogStore.js"
import * as InMemoryEventLogStore from "../../src/mneme/InMemoryEventLogStore.js"
import * as Coverage from "../../src/policy/Coverage.js"
import * as PolicyEngine from "../../src/policy/PolicyEngine.js"
import * as PolicyGate from "../../src/policy/PolicyGate.js"

/**
 * ADR-014's coverage measurement, end to end: decisions go through the gate, land in the event log,
 * and the report is computed back out of the log.
 *
 * Reading the report from the log rather than from in-process counters is the point — the number an
 * auditor would compute and the number METIS reports come from the same record.
 */

const vector = JSON.parse(
  readFileSync(resolve(__dirname, "../../specs/policy/conformance/baseline.json"), "utf8")
) as { policy: unknown }

const policy = Schema.decodeUnknownSync(Policy)(vector.policy)
const request = (fields: Record<string, unknown>) => Schema.decodeUnknownSync(PolicyRequest)(fields)

/** Gate + engine + a fresh in-memory log, so each test starts from an empty record. */
const stack = Layer.provideMerge(
  Layer.provide(PolicyGate.layer, Layer.merge(PolicyEngine.layer(policy), InMemoryEventLogStore.layer)),
  Layer.merge(PolicyEngine.layer(policy), InMemoryEventLogStore.layer)
)

const run = <A, E>(effect: Effect.Effect<A, E, PolicyGate.PolicyGate | EventLogStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(stack)) as Effect.Effect<A, E>)

describe("every evaluation reaches the event log", () => {
  it("writes a POLICY_EVALUATED event per check, including unmatched ones", async () => {
    const events = await run(
      Effect.gen(function*() {
        const gate = yield* PolicyGate.PolicyGate
        const log = yield* EventLogStore

        yield* gate.check(request({ at: "artifact_write", actor: "metis", autonomy: "S1" }))
        yield* gate.check(
          request({
            at: "tool_dispatch",
            actor: "metis",
            autonomy: "S2",
            capability: "agent.web_navigate@1.0",
            tags: ["untrusted"]
          })
        )

        return yield* log.read({})
      })
    )

    expect(events).toHaveLength(2)
    expect(events.every((e) => e.type === "POLICY_EVALUATED")).toBe(true)

    // The unmatched one is recorded, not skipped. If it were dropped, coverage would read as
    // perfect exactly when the system is least governed.
    const bases = events.map((e) => (e.payload as { basis: { _tag: string } }).basis._tag)
    expect(bases).toContain("unmatched")
    expect(bases).toContain("matched")
  })
})

describe("the coverage report (ADR-014)", () => {
  it("reports zero evaluations honestly rather than dividing by zero", async () => {
    const result = await run(Coverage.report(policy))
    expect(result.evaluations).toBe(0)
    expect(result.unmatchedFraction).toBe(0)
    // With no evidence, no rule can be called vacuous — but every rule is dead.
    expect(result.vacuousRules).toEqual([])
    expect(result.deadRules.length).toBe(policy.rules.length)
  })

  it("computes the unmatched fraction from the log", async () => {
    const result = await run(
      Effect.gen(function*() {
        const gate = yield* PolicyGate.PolicyGate

        // Three ungoverned actions...
        for (let i = 0; i < 3; i++) {
          yield* gate.check(request({ at: "artifact_write", actor: "metis", autonomy: "S1" }))
        }
        // ...and one a rule had an opinion about.
        yield* gate.check(
          request({
            at: "tool_dispatch",
            actor: "metis",
            autonomy: "S2",
            capability: "agent.web_navigate@1.0",
            tags: ["untrusted"]
          })
        )

        return yield* Coverage.report(policy)
      })
    )

    expect(result.evaluations).toBe(4)
    expect(result.unmatched).toBe(3)
    expect(result.unmatchedFraction).toBeCloseTo(0.75, 10)
  })

  it("breaks coverage down by evaluation point", async () => {
    const result = await run(
      Effect.gen(function*() {
        const gate = yield* PolicyGate.PolicyGate
        yield* gate.check(request({ at: "artifact_write", actor: "metis", autonomy: "S1" }))
        yield* gate.check(request({ at: "plan_validation", actor: "metis", autonomy: "S1" }))
        yield* gate.check(
          request({
            at: "tool_dispatch",
            actor: "metis",
            autonomy: "S2",
            capability: "agent.web_navigate@1.0",
            tags: ["untrusted"]
          })
        )
        return yield* Coverage.report(policy)
      })
    )

    expect(result.byPoint.artifact_write).toEqual({ evaluations: 1, unmatched: 1 })
    expect(result.byPoint.plan_validation).toEqual({ evaluations: 1, unmatched: 1 })
    expect(result.byPoint.tool_dispatch).toEqual({ evaluations: 1, unmatched: 0 })
  })

  it("names rules that never fired as dead", async () => {
    const result = await run(
      Effect.gen(function*() {
        const gate = yield* PolicyGate.PolicyGate
        yield* gate.check(
          request({
            at: "tool_dispatch",
            actor: "metis",
            autonomy: "S2",
            capability: "agent.web_navigate@1.0",
            tags: ["untrusted"]
          })
        )
        return yield* Coverage.report(policy)
      })
    )

    expect(result.deadRules).not.toContain("deny.untrusted_to_agent")
    expect(result.deadRules).toContain("approve.expensive")
    expect(result.deadRules).toContain("allow.research_reads")
  })

  it("counts a rule that matched but did not win as considered, not dead", async () => {
    // A rule that constantly matches and never decides is not doing nothing — it is a candidate
    // vacuous rule, and calling it dead would hide that.
    const result = await run(
      Effect.gen(function*() {
        const gate = yield* PolicyGate.PolicyGate
        yield* gate.check(
          request({
            at: "tool_dispatch",
            actor: "metis",
            autonomy: "S3",
            capability: "research.search@0.1",
            estimatedDollars: 12,
            idempotent: true
          })
        )
        return yield* Coverage.report(policy)
      })
    )

    const research = result.rules.find((r) => r.ruleId === "allow.research_reads")!
    expect(research.consideredCount).toBe(1)
    expect(research.decidedCount).toBe(0)
    expect(result.deadRules).not.toContain("allow.research_reads")
  })

  it("flags a rule that matches effectively everything as vacuous", async () => {
    const vacuousPolicy = Schema.decodeUnknownSync(Policy)({
      version: "vacuous-1",
      defaultEffect: "allow",
      rules: [
        {
          id: "allow.everything",
          description: "Matches every request and therefore constrains nothing.",
          priority: 100,
          effect: "allow",
          when: {}
        }
      ]
    })

    const vacuousStack = Layer.provideMerge(
      Layer.provide(
        PolicyGate.layer,
        Layer.merge(PolicyEngine.layer(vacuousPolicy), InMemoryEventLogStore.layer)
      ),
      Layer.merge(PolicyEngine.layer(vacuousPolicy), InMemoryEventLogStore.layer)
    )

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const gate = yield* PolicyGate.PolicyGate
        for (let i = 0; i < 10; i++) {
          yield* gate.check(request({ at: "tool_dispatch", actor: "metis", autonomy: "S2" }))
        }
        return yield* Coverage.report(vacuousPolicy)
      }).pipe(Effect.provide(vacuousStack)) as Effect.Effect<Coverage.CoverageReport>
    )

    // Coverage looks perfect...
    expect(result.unmatchedFraction).toBe(0)
    // ...which is exactly why vacuity is tracked separately. A rule can drive the headline number
    // to zero while governing nothing at all.
    expect(result.vacuousRules).toEqual(["allow.everything"])
  })
})
