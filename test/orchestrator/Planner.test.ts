import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { Intent } from "../../src/domain/Intent.js"
import { Plan } from "../../src/domain/Plan.js"
import * as Planner from "../../src/orchestrator/Planner.js"

const intent = (goal: string, autonomy = "S1") =>
  Schema.decodeUnknownSync(Intent)({
    id: "01890a5d-ac96-774b-bcce-b302099a8057",
    ts: 1735872000,
    actor: "user:andysakov",
    goal,
    autonomy
  })

const planFor = (goal: string, autonomy = "S1") =>
  Effect.runPromise(
    Effect.gen(function*() {
      const planner = yield* Planner.Planner
      return yield* planner.plan(intent(goal, autonomy))
    }).pipe(Effect.provide(Planner.layer))
  )

describe("the planner produces valid plans", () => {
  it("every plan it emits round-trips through the Plan schema", async () => {
    const goals = [
      "Draft a PRD for a research summarizer",
      "Research the state of the art in retrieval-augmented generation",
      "Something completely unrecognised"
    ]

    for (const goal of goals) {
      const plan = await planFor(goal)
      // Encode then decode: a plan the schema cannot serialise is not a valid plan, however
      // plausible the object looks in memory.
      const encoded = Schema.encodeSync(Plan)(plan)
      expect(() => Schema.decodeUnknownSync(Plan)(encoded)).not.toThrow()
    }
  })

  it("matches the PRD template on a PRD goal", async () => {
    const plan = await planFor("Draft a PRD for a research summarizer")
    expect(plan.steps.map((s) => s.toolCall?.capability)).toEqual([
      "research.search@0.1",
      "research.summarize@0.1",
      "design.prd@1.0"
    ])
  })

  it("asks rather than guessing when it does not recognise the goal", async () => {
    const plan = await planFor("xyzzy plugh")
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.kind).toBe("ask")
    expect(plan.steps[0]!.toolCall).toBeUndefined()
    // An unrecognised intent should be visible as a risk, not silently planned around.
    expect(plan.risks.length).toBeGreaterThan(0)
  })

  it("never names a tool implementation (ADR-017)", async () => {
    // The planner targets capabilities. If it started resolving implementations, hot-swap and
    // policy-based selection would both quietly stop working.
    for (const goal of ["Draft a PRD", "Research RAG"]) {
      const plan = await planFor(goal)
      for (const step of plan.steps) {
        expect(step.toolCall?.tool, `${goal}: step must not name a tool`).toBeUndefined()
      }
    }
  })

  it("references the intent by id rather than embedding it", async () => {
    const plan = await planFor("Draft a PRD")
    expect(plan.intentId).toBe("01890a5d-ac96-774b-bcce-b302099a8057")
    expect((plan as unknown as Record<string, unknown>).generatedFrom).toBeUndefined()
  })

  it("gives every step a distinct time-sortable id", async () => {
    const plan = await planFor("Draft a PRD for a research summarizer")
    const ids = plan.steps.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...ids])
  })
})

describe("approval gating follows the gear (ADR-002)", () => {
  it("S3 gated run requires approval for tool steps", async () => {
    const plan = await planFor("Draft a PRD", "S3")
    expect(plan.steps.every((s) => s.requiresApproval)).toBe(true)
  })

  it("S2 sandbox run does not gate — it has no external effect", async () => {
    const plan = await planFor("Draft a PRD", "S2")
    expect(plan.steps.some((s) => s.requiresApproval)).toBe(false)
  })

  it("S0 and S1 gate tool steps, because at those gears nothing should execute", async () => {
    for (const gear of ["S0", "S1"]) {
      const plan = await planFor("Draft a PRD", gear)
      expect(plan.steps.every((s) => s.requiresApproval), `gear ${gear}`).toBe(true)
    }
  })

  it("never gates a step that has nothing to approve", () => {
    for (const gear of ["S0", "S1", "S2", "S3", "S4"] as const) {
      expect(Planner.stepRequiresApproval("ask", gear), `ask at ${gear}`).toBe(false)
      expect(Planner.stepRequiresApproval("decision", gear), `decision at ${gear}`).toBe(false)
    }
  })

  it("S4 does not prompt, because nobody is watching when it fires", () => {
    // The gate at S4 is policy and the trust ledger, not a prompt. This is a deliberate choice and
    // worth pinning: making S4 prompt would make scheduled autonomy useless, and making S3 not
    // prompt would make gated runs a lie.
    expect(Planner.stepRequiresApproval("tool", "S4")).toBe(false)
    expect(Planner.stepRequiresApproval("tool", "S3")).toBe(true)
  })
})
