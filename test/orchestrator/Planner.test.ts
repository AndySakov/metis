import { readFileSync } from "node:fs"
import { resolve } from "node:path"

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
      "design.prd@1.0"
    ])
  })

  it("matches the C4 and API templates", async () => {
    expect((await planFor("C4 diagrams for a notes app")).steps.map((s) => s.toolCall?.capability)).toEqual([
      "design.c4@1.0"
    ])
    expect((await planFor("Write an API spec for a notes app")).steps.map((s) => s.toolCall?.capability)).toEqual([
      "design.api_spec@1.0"
    ])
  })

  it("gives every tool step an input its capability's contract accepts", async () => {
    // Steps take fixed inputs: nothing carries one step's output into the next. A step whose input
    // cannot satisfy its capability's input schema therefore fails every time it runs.
    const goals = [
      "Draft a PRD for a research summarizer",
      "Research the state of the art in RAG",
      "C4 diagrams for a notes app",
      "Write an API spec for a notes app",
      "Scaffold a TypeScript project called notes-api",
      "Summarize https://example.com/notes"
    ]
    for (const goal of goals) {
      for (const step of (await planFor(goal)).steps) {
        if (step.toolCall === undefined) continue
        const schema = JSON.parse(
          readFileSync(
            resolve(__dirname, `../../specs/capabilities/${step.toolCall.capability}.input.schema.json`),
            "utf8"
          )
        ) as { required?: Array<string>; properties?: Record<string, unknown>; additionalProperties?: boolean }
        const keys = Object.keys(step.toolCall.input)
        for (const key of schema.required ?? []) {
          expect(keys, `${goal}: ${step.toolCall.capability} requires ${key}`).toContain(key)
        }
        if (schema.additionalProperties === false) {
          for (const key of keys) {
            expect(Object.keys(schema.properties ?? {}), `${goal}: ${step.toolCall.capability} has no ${key}`)
              .toContain(key)
          }
        }
      }
    }
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

describe("planning against what is available", () => {
  const planWith = (available: ReadonlyArray<string>, goal: string) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const planner = yield* Planner.Planner
        return yield* planner.plan(intent(goal, "S2"))
      }).pipe(Effect.provide(Planner.layerFor((capability) => available.includes(capability))))
    )

  it("leaves out a step with no implementation and says so as a risk", async () => {
    const plan = await planWith(["design.prd@1.0"], "Draft a PRD for a research summarizer")
    expect(plan.steps.map((s) => s.toolCall?.capability)).toEqual(["design.prd@1.0"])
    expect(plan.risks.map((r) => r.description).join("\n")).toContain("research.search@0.1")
  })

  it("asks instead when nothing the goal needs can run", async () => {
    const plan = await planWith([], "Research the state of the art in RAG")
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]!.kind).toBe("ask")
    expect(plan.risks.map((r) => r.description).join("\n")).toContain("research.search@0.1")
  })

  it("changes nothing when everything is available", async () => {
    const plan = await planWith(["research.search@0.1", "design.prd@1.0"], "Draft a PRD")
    expect(plan.steps.map((s) => s.toolCall?.capability)).toEqual(["research.search@0.1", "design.prd@1.0"])
    expect(plan.risks.map((r) => r.description).join("\n")).not.toContain("Skipped")
  })
})

describe("a document is titled by its subject, not by the request", () => {
  const inputOf = async (goal: string) =>
    (await planFor(goal)).steps.find((s) => s.toolCall?.capability.startsWith("design."))!.toolCall!.input

  it("takes the subject after the request phrase", async () => {
    expect((await inputOf("Draft a PRD for an offline-first notes app")).title).toBe("Offline-first notes app")
    expect((await inputOf("C4 diagrams for the billing service")).title).toBe("Billing service")
    expect((await inputOf("Write an API spec for a notes app")).title).toBe("Notes app")
    expect((await inputOf("product requirements document about team calendars")).title).toBe("Team calendars")
  })

  it("keeps the whole goal where the capability's contract has room for it", async () => {
    const prd = await inputOf("Draft a PRD for an offline-first notes app")
    expect(prd.context).toBe("Draft a PRD for an offline-first notes app")
    const c4 = await inputOf("C4 diagrams for the billing service")
    expect(c4.description).toBe("C4 diagrams for the billing service")
  })

  it("falls back to the goal when there is no subject to take", async () => {
    expect((await inputOf("Draft a PRD")).title).toBe("Draft a PRD")
  })
})

describe("a scaffold goal plans a project the tool will accept", () => {
  const inputOf = async (goal: string) => {
    const step = (await planFor(goal)).steps.find((s) => s.toolCall?.capability === "build.scaffold@0.1")
    expect(step, goal).toBeDefined()
    return step!.toolCall!.input
  }

  it("uses the name the goal gives, and infers the stack", async () => {
    expect(await inputOf("Scaffold a TypeScript project called notes-api")).toEqual({
      name: "notes-api",
      stack: "node-ts"
    })
    expect(await inputOf("Bootstrap a new Python service named Data_Tool")).toEqual({
      name: "data-tool",
      stack: "python"
    })
  })

  it("derives a name from the subject when none is given", async () => {
    expect((await inputOf("Scaffold a project for an offline-first notes app")).name).toBe("offline-first-notes-app")
    expect((await inputOf("Scaffold 3D viewer")).name).toBe("app-3d-viewer")
    expect((await inputOf("Scaffold a project")).name).toBe("new-project")
  })

  it("always produces a name build.scaffold accepts", async () => {
    for (
      const goal of [
        "Scaffold a project called ../../etc",
        "bootstrap a service named /root",
        `Scaffold a project for ${"very long name ".repeat(10).trim()}`,
        "Scaffold a project called ---"
      ]
    ) {
      expect((await inputOf(goal)).name, goal).toMatch(/^[a-z][a-z0-9-]{0,62}$/)
    }
  })

  it("leaves a document request about scaffolding to the document template", async () => {
    expect((await planFor("Draft a PRD for a scaffold generator")).steps.map((s) => s.toolCall?.capability))
      .toEqual(["research.search@0.1", "design.prd@1.0"])
  })
})

describe("a summarize goal with a URL chains a fetch into a summary", () => {
  it("binds the fetched text into the summary's input", async () => {
    const plan = await planFor("Summarize https://example.com/posts/offline-first.")
    expect(plan.steps.map((s) => s.toolCall?.capability)).toEqual(["research.fetch@0.1", "research.summarize@0.1"])
    expect(plan.steps[0]!.toolCall!.input).toEqual({ url: "https://example.com/posts/offline-first" })
    expect(plan.steps[1]!.toolCall!.input).toEqual({ chunks: [{ source: "https://example.com/posts/offline-first" }] })
    expect(plan.steps[1]!.toolCall!.bindings).toEqual([
      { to: "/chunks/0/text", fromStep: plan.steps[0]!.id, from: "/text" }
    ])
  })

  it("takes the URL whole, keeping brackets it opened and dropping the sentence's", () => {
    expect(Planner.urlIn("Summarize https://en.wikipedia.org/wiki/Metis_(mythology).")).toBe(
      "https://en.wikipedia.org/wiki/Metis_(mythology)"
    )
    expect(Planner.urlIn("(summarize https://example.com/a)")).toBe("https://example.com/a")
    expect(Planner.urlIn("tl;dr https://example.com/x?y=1, please!")).toBe("https://example.com/x?y=1")
    expect(Planner.urlIn("summarize this")).toBeUndefined()
  })

  it("wins over the document templates when the goal points at a page", async () => {
    expect((await planFor("Give me a summary of the PRD at https://example.com/prd")).steps[0]!.toolCall!.capability)
      .toBe("research.fetch@0.1")
  })

  it("is not used without a URL", async () => {
    expect((await planFor("Summarize the state of the art in RAG")).steps.map((s) => s.toolCall?.capability))
      .toEqual(["research.search@0.1"])
  })

  it("leaves out the summary too when the fetch cannot run, and says why", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function*() {
        const planner = yield* Planner.Planner
        return yield* planner.plan(intent("Summarize https://example.com/notes", "S2"))
      }).pipe(Effect.provide(Planner.layerFor((capability) => capability === "research.summarize@0.1")))
    )
    expect(plan.steps.map((s) => s.kind)).toEqual(["ask"])
    const risks = plan.risks.map((r) => r.description).join("\n")
    expect(risks).toContain("research.fetch@0.1 has no registered implementation")
    expect(risks).toContain(`"Summarize what was fetched": it needs the output of "Fetch the page"`)
  })
})

describe("a leads goal triages what was pasted with it", () => {
  const withPaste = (goal: string, pasted?: string) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const planner = yield* Planner.Planner
        return yield* planner.plan(
          Schema.decodeUnknownSync(Intent)({
            id: "01890a5d-ac96-774b-bcce-b302099a8057",
            ts: 1735872000,
            actor: "user:andysakov",
            goal,
            autonomy: "S2",
            inputs: pasted === undefined ? [] : [{ name: "pasted", value: pasted, tags: ["untrusted", "pasted"] }]
          })
        )
      }).pipe(Effect.provide(Planner.layer))
    )

  it("plans stays.triage over the pasted chat", async () => {
    const plan = await withPaste("Any leads in this group chat?", "Anyone with a 1br in Westlands?")
    expect(plan.steps.map((s) => s.toolCall)).toEqual([
      expect.objectContaining({
        capability: "stays.triage@0.1",
        input: { messages: "Anyone with a 1br in Westlands?" }
      })
    ])
  })

  it("asks for the chat when nothing was pasted", async () => {
    const plan = await withPaste("Any leads today?")
    expect(plan.steps.map((s) => s.kind)).toEqual(["ask"])
    expect(plan.steps[0]!.description).toContain("Paste the group chat")
  })

  it("leaves a document about leads to the document template", async () => {
    expect((await withPaste("Draft a PRD for a leads dashboard")).steps.at(-1)!.toolCall!.capability).toBe(
      "design.prd@1.0"
    )
  })
})

describe("an availability question checks the booking sheet", () => {
  it("hands the question's words to stays.availability", async () => {
    const plan = await planFor("Is the unit free from 15 to 18 November?")
    expect(plan.steps.map((s) => s.toolCall)).toEqual([
      expect.objectContaining({
        capability: "stays.availability@0.1",
        input: { when: "Is the unit free from 15 to 18 November?" }
      })
    ])
  })

  it("leaves documents and lead sweeps to their own templates", async () => {
    expect((await planFor("Draft a PRD for a free notes app")).steps.at(-1)!.toolCall!.capability).toBe(
      "design.prd@1.0"
    )
    expect((await planFor("Any leads available today?")).steps.map((s) => s.kind)).toEqual(["ask"])
  })
})
