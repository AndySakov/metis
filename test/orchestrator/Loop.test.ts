import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"

import { uuidv7 } from "../../src/domain/Ids.js"
import { Intent } from "../../src/domain/Intent.js"
import { Policy } from "../../src/domain/Policy.js"
import { ToolSpec } from "../../src/domain/ToolSpec.js"
import { TrustPolicy, TrustRecord } from "../../src/domain/Trust.js"
import type { Score, SkillId } from "../../src/domain/Trust.js"
import { ArtifactStore } from "../../src/mneme/ArtifactStore.js"
import { EventLogStore } from "../../src/mneme/EventLogStore.js"
import * as InMemoryArtifactStore from "../../src/mneme/InMemoryArtifactStore.js"
import * as InMemoryEventLogStore from "../../src/mneme/InMemoryEventLogStore.js"
import * as Executor from "../../src/orchestrator/Executor.js"
import * as Planner from "../../src/orchestrator/Planner.js"
import * as Coverage from "../../src/policy/Coverage.js"
import * as PolicyEngine from "../../src/policy/PolicyEngine.js"
import * as PolicyGate from "../../src/policy/PolicyGate.js"
import * as TrustLedger from "../../src/policy/TrustLedger.js"
import { derive } from "../../src/policy/TrustUpdater.js"
import * as Verification from "../../src/policy/Verification.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import * as ToolRegistry from "../../src/tools/ToolRegistry.js"

/**
 * The loop, end to end, over a real MCP process.
 *
 * Intent → Plan → execute → policy at three points → artifact with checksum and provenance, with
 * every step recorded in the event log. The `design.prd` call crosses a process boundary over
 * stdio, so the transport is genuinely exercised rather than stubbed.
 */

const decodeToolSpec = Schema.decodeUnknownSync(ToolSpec)

const prdSpec = decodeToolSpec({
  ...JSON.parse(readFileSync(resolve(__dirname, "../../specs/tools/examples/design.prd.tool.json"), "utf8")),
  // The example descriptor is a template; point it at the server this repo actually ships.
  mcp: { server: "metis.design", tool: "prd", transport: "stdio" }
})

const servers: McpToolRunner.ServerMap = {
  "metis.design": {
    command: "node",
    args: ["--experimental-strip-types", resolve(__dirname, "../../src/tools/servers/design.ts")]
  }
}

/** Only design.prd is registered, so the PRD plan's research steps fail to resolve. */
const registry = ToolRegistry.layer([prdSpec])

const policyFrom = (rules: unknown) => Schema.decodeUnknownSync(Policy)(rules)

const permissive = policyFrom({ version: "loop-1", defaultEffect: "allow", rules: [] })

/** Thresholds low enough that a fully-trusted record clears every gear. */
const trustPolicy = Schema.decodeUnknownSync(TrustPolicy)({
  decay: { competenceHalfLifeSeconds: 30 * 86400, complianceHalfLifeSeconds: 14 * 86400 },
  thresholds: [
    { gear: "S1", minCompetence: 0.2, minCompliance: 0.2, minSignals: 0 },
    { gear: "S2", minCompetence: 0.5, minCompliance: 0.5, minSignals: 0 },
    { gear: "S3", minCompetence: 0.7, minCompliance: 0.8, minSignals: 0 },
    { gear: "S4", minCompetence: 0.8, minCompliance: 0.95, minSignals: 0 }
  ]
})

const trusted = (competence: number, compliance: number) =>
  new TrustRecord({
    skill: "design.prd" as SkillId,
    competence: competence as Score,
    compliance: compliance as Score,
    gear: "S0",
    updatedAt: Math.floor(Date.now() / 1000) as never
  })

const stack = (
  policy: Policy,
  options: { trust?: ReadonlyArray<TrustRecord>; sample?: boolean } = {}
) => {
  const stores = Layer.merge(InMemoryEventLogStore.layer, InMemoryArtifactStore.layer)
  const engine = PolicyEngine.layer(policy)
  const gate = Layer.provide(PolicyGate.layer, Layer.merge(engine, stores))
  return Layer.mergeAll(
    stores,
    engine,
    gate,
    registry,
    McpToolRunner.layer(servers),
    Planner.layer,
    TrustLedger.layer(trustPolicy, options.trust ?? [trusted(1, 1)]),
    options.sample === true ? Verification.alwaysSample : Verification.neverSample
  )
}

const intentFor = (goal: string, autonomy: string) =>
  Schema.decodeUnknownSync(Intent)({
    id: "01890a5d-ac96-774b-bcce-b302099a8057",
    ts: 1735872000,
    actor: "user:andysakov",
    goal,
    autonomy
  })

/** Runs a single-step PRD plan, so the only capability needed is the one that is registered. */
const runLoop = (
  goal: string,
  autonomy: string,
  policy: Policy,
  approve: boolean,
  options: { trust?: ReadonlyArray<TrustRecord>; sample?: boolean } = {}
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const planner = yield* Planner.Planner
        const intent = intentFor(goal, autonomy)
        const full = yield* planner.plan(intent)

        // Keep only the design.prd step — the research capabilities have no registered
        // implementation, which is a separate case tested below.
        const step = full.steps.find((s) => s.toolCall?.capability === "design.prd@1.0")!
        const plan = { ...full, steps: [step] } as typeof full

        const first = yield* Executor.execute(intent, plan)
        const report = approve && first.status === "awaiting_approval"
          ? yield* Executor.execute(intent, plan, { approvedSteps: [step.id] })
          : first

        const log = yield* EventLogStore
        const events = yield* Effect.orDie(log.read({}))
        const artifacts = yield* ArtifactStore
        const coverage = yield* Coverage.report(policy)

        return { report, events, artifacts, coverage }
      })
    ).pipe(Effect.provide(stack(policy, options))) as Effect.Effect<any>
  )

describe("the loop runs end to end", () => {
  it("produces a stored artifact with a verified checksum and provenance", async () => {
    const { artifacts, report } = await runLoop("Draft a PRD for a research summarizer", "S2", permissive, false)

    expect(report.status).toBe("completed")
    const artifactId = report.steps[0].artifactId
    expect(artifactId).toBeDefined()

    const stored = await Effect.runPromise(
      Effect.either(artifacts.get(artifactId)) as Effect.Effect<any>
    )
    expect(stored._tag).toBe("Right")

    const text = new TextDecoder().decode(stored.right.payload)
    // The content came back over MCP from the separate process.
    expect(text).toContain("# Draft a PRD for a research summarizer")
    expect(text).toContain("## Goals")

    // Checksum verified on read, and provenance points at both the plan and the intent (ADR-001).
    const rels = stored.right.metadata.provenance.map((p: { rel: string }) => p.rel)
    expect(rels).toContain("produced_by")
    expect(rels).toContain("derives_from")
    expect(stored.right.metadata.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
  }, 30_000)

  it("records the whole run in the event log", async () => {
    const { events } = await runLoop("Draft a PRD for a research summarizer", "S2", permissive, false)
    const types = events.map((e: { type: string }) => e.type)

    expect(types).toContain("PLAN_STARTED")
    expect(types).toContain("TOOL_STARTED")
    expect(types).toContain("TOOL_COMPLETED")
    expect(types).toContain("ARTIFACT_WRITTEN")
    expect(types).toContain("PLAN_FINISHED")

    // One correlation id ties the run together (ADR-009).
    const correlations = new Set(events.map((e: { correlationId?: string }) => e.correlationId))
    expect(correlations.size).toBe(1)
  }, 30_000)

  it("evaluates policy at all three points", async () => {
    const { coverage } = await runLoop("Draft a PRD for a research summarizer", "S2", permissive, false)

    // This is the claim that was previously untrue: policy is *in* the execution path, not merely
    // available to it.
    expect(coverage.byPoint.plan_validation.evaluations).toBeGreaterThan(0)
    expect(coverage.byPoint.tool_dispatch.evaluations).toBeGreaterThan(0)
    expect(coverage.byPoint.artifact_write.evaluations).toBeGreaterThan(0)

    // With an empty policy nothing is governed, and the report says so rather than staying silent.
    expect(coverage.unmatchedFraction).toBe(1)
  }, 30_000)
})

describe("approval genuinely gates execution", () => {
  it("stops at a gated step and completes once approved", async () => {
    const withoutApproval = await runLoop("Draft a PRD", "S3", permissive, false)
    expect(withoutApproval.report.status).toBe("awaiting_approval")
    expect(withoutApproval.report.steps[0].artifactId).toBeUndefined()

    // Nothing was written while waiting.
    const requested = withoutApproval.events.map((e: { type: string }) => e.type)
    expect(requested).toContain("APPROVAL_REQUESTED")
    expect(requested).not.toContain("ARTIFACT_WRITTEN")

    const withApproval = await runLoop("Draft a PRD", "S3", permissive, true)
    expect(withApproval.report.status).toBe("completed")
    expect(withApproval.report.steps[0].artifactId).toBeDefined()
    expect(withApproval.events.map((e: { type: string }) => e.type)).toContain("APPROVAL_GRANTED")
  }, 30_000)
})

describe("policy stops the run", () => {
  const denyPrd = policyFrom({
    version: "deny-1",
    defaultEffect: "allow",
    rules: [
      {
        id: "deny.design",
        description: "Blocks design capabilities outright.",
        priority: 0,
        effect: "deny",
        when: { at: "tool_dispatch", capabilities: ["design.*"] }
      }
    ]
  })

  it("a denied dispatch produces no artifact and is recorded", async () => {
    const { artifacts: _artifacts, events, report } = await runLoop("Draft a PRD", "S2", denyPrd, false)

    expect(report.status).toBe("denied")
    const types = events.map((e: { type: string }) => e.type)
    expect(types).toContain("STEP_DENIED")
    expect(types).not.toContain("TOOL_STARTED")
    expect(types).not.toContain("ARTIFACT_WRITTEN")
  }, 30_000)

  it("the denial names the rule that caused it", async () => {
    const { coverage } = await runLoop("Draft a PRD", "S2", denyPrd, false)
    const rule = coverage.rules.find((r: { ruleId: string }) => r.ruleId === "deny.design")
    expect(rule.decidedCount).toBe(1)
    expect(coverage.deadRules).not.toContain("deny.design")
  }, 30_000)
})

describe("an unresolvable capability fails cleanly", () => {
  it("reports the failure instead of dispatching something else", async () => {
    const report = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const planner = yield* Planner.Planner
          const intent = intentFor("Research the state of the art in RAG", "S2")
          const plan = yield* planner.plan(intent)
          return yield* Executor.execute(intent, plan)
        })
      ).pipe(Effect.provide(stack(permissive))) as Effect.Effect<any>
    )

    // research.search@0.1 has no registered implementation.
    expect(report.status).toBe("failed")
    expect(report.steps[0].detail).toContain("no implementation registered")
  }, 30_000)

  it("is denied by a rule when policy has one, and the denial is in the log", async () => {
    const denyUnregistered = policyFrom({
      version: "unregistered-1",
      defaultEffect: "allow",
      rules: [
        {
          id: "deny.unregistered_capability",
          description: "A dispatch to a capability the registry does not hold is refused.",
          priority: 0,
          effect: "deny",
          when: { at: "tool_dispatch", unregistered: true }
        }
      ]
    })

    const { coverage, events, report } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const planner = yield* Planner.Planner
          const intent = intentFor("Research the state of the art in RAG", "S4")
          const plan = yield* planner.plan(intent)
          const report = yield* Executor.execute(intent, plan)
          const log = yield* EventLogStore
          const events = yield* Effect.orDie(log.read({}))
          const coverage = yield* Coverage.report(denyUnregistered)
          return { coverage, events, report }
        })
      ).pipe(Effect.provide(stack(denyUnregistered))) as Effect.Effect<any>
    )

    // Stopped by a rule rather than by the lookup failing: the difference is whether the event
    // log, and so the coverage report, can see it.
    expect(report.status).toBe("denied")
    const types = events.map((e: { type: string }) => e.type)
    expect(types).toContain("STEP_DENIED")
    expect(types).not.toContain("TOOL_STARTED")
    const rule = coverage.rules.find((r: { ruleId: string }) => r.ruleId === "deny.unregistered_capability")
    expect(rule.decidedCount).toBe(1)
  }, 30_000)

  it("a registered capability is dispatched as registered", async () => {
    const denyUnregistered = policyFrom({
      version: "unregistered-1",
      defaultEffect: "allow",
      rules: [
        {
          id: "deny.unregistered_capability",
          description: "A dispatch to a capability the registry does not hold is refused.",
          priority: 0,
          effect: "deny",
          when: { unregistered: true }
        }
      ]
    })
    const { coverage, report } = await runLoop("Draft a PRD", "S2", denyUnregistered, false)

    expect(report.status).toBe("completed")
    expect(coverage.deadRules).toContain("deny.unregistered_capability")
  }, 30_000)
})

describe("isolation reaches policy from the resolved descriptor (ADR-020)", () => {
  const requiring = (tier: string) =>
    policyFrom({
      version: `isolation-${tier}`,
      defaultEffect: "allow",
      rules: [
        {
          id: "deny.unattended_below_minimum",
          description: "Nothing runs unattended below the required tier.",
          priority: 0,
          effect: "deny",
          when: { at: "tool_dispatch", autonomy: ["S4"], isolationBelow: tier }
        }
      ]
    })

  it("a process-isolated tool meets a process minimum", async () => {
    const { report } = await runLoop("Draft a PRD", "S4", requiring("process"), false)
    expect(report.status).toBe("completed")
  }, 30_000)

  it("a process-isolated tool is refused where a container is required", async () => {
    const { coverage, report } = await runLoop("Draft a PRD", "S4", requiring("container"), false)
    expect(report.status).toBe("denied")
    const rule = coverage.rules.find((r: { ruleId: string }) => r.ruleId === "deny.unattended_below_minimum")
    expect(rule.decidedCount).toBe(1)
  }, 30_000)
})

describe("gear enforcement: trust bounds what runs unattended", () => {
  it("an untrusted skill cannot run at S4, even with permissive policy", async () => {
    // Policy allows everything; the ledger does not. The gear a skill may hold is earned, and
    // asking for S4 does not grant it.
    const { events, report } = await runLoop("Draft a PRD", "S4", permissive, false, {
      trust: [trusted(0.1, 0.1)]
    })

    expect(report.status).toBe("awaiting_approval")

    const gate = events.find((e: { type: string }) => e.type === "TRUST_GATE")
    expect(gate, "the gating decision must be recorded, not silent").toBeDefined()
    expect(gate.payload.requestedGear).toBe("S4")
    expect(gate.payload.blockedBy).toContain("compliance")
  }, 30_000)

  it("a competent but non-compliant skill is still gated at S4", async () => {
    // The ADR-014 case, now enforced in the execution path rather than only computable.
    const { events, report } = await runLoop("Draft a PRD", "S4", permissive, false, {
      trust: [trusted(1, 0.5)]
    })

    expect(report.status).toBe("awaiting_approval")
    const gate = events.find((e: { type: string }) => e.type === "TRUST_GATE")
    expect(gate.payload.blockedBy).toEqual(["compliance"])
  }, 30_000)

  it("a fully trusted skill runs unattended at S4", async () => {
    const { events, report } = await runLoop("Draft a PRD", "S4", permissive, false, {
      trust: [trusted(1, 1)]
    })

    expect(report.status).toBe("completed")
    expect(events.find((e: { type: string }) => e.type === "TRUST_GATE")).toBeUndefined()
  }, 30_000)

  it("an unknown skill is untrusted and therefore gated", async () => {
    const { report } = await runLoop("Draft a PRD", "S4", permissive, false, { trust: [] })
    expect(report.status).toBe("awaiting_approval")
  }, 30_000)
})

describe("sampled verification (ADR-014 §4)", () => {
  it("records a sampled action independently of any rule", async () => {
    const { events } = await runLoop("Draft a PRD", "S2", permissive, false, { sample: true })

    const sampled = events.find((e: { type: string }) => e.type === "VERIFICATION_SAMPLED")
    expect(sampled, "a sampled action must leave a record").toBeDefined()
    // Written whether or not it was clean — a log of failures only would make the clean rate,
    // which feeds the compliance ledger, impossible to compute.
    expect(typeof sampled.payload.clean).toBe("boolean")
    expect(sampled.correlationId).toBeDefined()
  }, 30_000)

  it("does not sample when the rate says not to", async () => {
    const { events } = await runLoop("Draft a PRD", "S2", permissive, false, { sample: false })
    expect(events.find((e: { type: string }) => e.type === "VERIFICATION_SAMPLED")).toBeUndefined()
  }, 30_000)
})

/**
 * A doom loop: the same capability called with the same input, over and over.
 *
 * Distinct step ids, identical `(capability, input)` — which is the shape the breaker has to key
 * on. Keying on the step id would miss it entirely, since a loop that repeats is by definition
 * producing new step identities each time round.
 */
const runRepeated = (copies: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const planner = yield* Planner.Planner
        const intent = intentFor("Draft a PRD for a research summarizer", "S2")
        const full = yield* planner.plan(intent)
        const step = full.steps.find((s) => s.toolCall?.capability === "design.prd@1.0")!
        const steps = Array.from({ length: copies }, () => ({ ...step, id: uuidv7() as typeof step.id }))
        // Spreading the step drops the class identity the schema gives it; the executor reads it
        // structurally, so the double cast is the honest way to say so.
        const plan = { ...full, steps } as unknown as typeof full

        const report = yield* Executor.execute(intent, plan)
        const log = yield* EventLogStore
        const events = yield* Effect.orDie(log.read({}))
        return { events, report }
      })
    ).pipe(Effect.provide(stack(permissive))) as Effect.Effect<any>
  )

describe("a repeated identical call trips the circuit breaker", () => {
  it("does not fire below the threshold", async () => {
    const { report } = await runRepeated(2)

    expect(report.status).toBe("completed")
    expect(report.steps.map((s: { status: string }) => s.status)).toEqual(["completed", "completed"])
  })

  it("forces approval on the third identical dispatch rather than denying it", async () => {
    const { report } = await runRepeated(3)

    expect(report.steps.map((s: { status: string }) => s.status)).toEqual([
      "completed",
      "completed",
      "awaiting_approval"
    ])
    expect(report.status).toBe("awaiting_approval")
  })

  it("records the trip in the event log with the repeat count", async () => {
    const { events } = await runRepeated(3)

    const tripped = events.find((e: { type: string }) => e.type === "DOOM_LOOP_DETECTED")
    expect(tripped, "a circuit-breaker trip must leave a record").toBeDefined()
    expect(tripped.payload.capability).toBe("design.prd@1.0")
    expect(tripped.payload.repeats).toBe(3)
  })
})

describe("a run's outcome reaches the skill's competence ledger", () => {
  const competence = (events: ReadonlyArray<any>) =>
    derive(events, "design.prd" as SkillId, trustPolicy, Math.floor(Date.now() / 1000) as never).record

  it("an approval granted counts for the skill that was approved", async () => {
    const { events } = await runLoop("Draft a PRD", "S3", permissive, true)
    // APPROVAL_GRANTED and TOOL_COMPLETED, both credited to design.prd.
    expect(competence(events).competenceSignals).toBe(2)
  }, 30_000)

  it("a tool that fails counts against the skill that failed", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const planner = yield* Planner.Planner
          const intent = intentFor("Draft a PRD", "S2")
          const full = yield* planner.plan(intent)
          const step = full.steps.find((s) => s.toolCall?.capability === "design.prd@1.0")!
          // An input the tool's own schema rejects: the call reaches the tool and fails there.
          const broken = { ...step, toolCall: { ...step.toolCall!, input: {} } }
          yield* Executor.execute(intent, { ...full, steps: [broken] } as typeof full)
          const log = yield* EventLogStore
          return yield* Effect.orDie(log.read({}))
        })
      ).pipe(Effect.provide(stack(permissive))) as Effect.Effect<any>
    )

    expect(events.map((e: { type: string }) => e.type)).toContain("STEP_FAILED")
    const record = competence(events)
    expect(record.competenceSignals).toBe(1)
    expect(record.competence).toBe(0)
  }, 30_000)
})
