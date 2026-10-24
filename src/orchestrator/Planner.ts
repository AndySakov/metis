/**
 * Intent → Plan.
 *
 * Deliberately dumb: templates matched on the goal text, as REBUILD-PLAN Stage 2 specifies. The
 * requirement is that it produces a *valid* Plan, not a smart one — everything downstream (policy
 * evaluation, approval gating, execution, provenance) is exercised by a plan that is structurally
 * correct, and none of it gets better by making the planner clever first.
 *
 * The one piece of real judgement here is `requiresApproval`, which is derived from the autonomy
 * gear rather than hardcoded per template. Getting that wrong would mean approval gates that do not
 * fire, so it is computed in one place and tested directly.
 */

import { Context, Effect, Layer } from "effect"

import type { Autonomy, CapabilityId, EpochSeconds } from "../domain/Common.js"
import { uuidv7 } from "../domain/Ids.js"
import type { Intent } from "../domain/Intent.js"
import type { ArtifactExpectationId, AssumptionId, PlanId, PlanStepId, RiskId } from "../domain/Plan.js"
import { ArtifactExpectation, Assumption, Plan, PlanStep, Risk, ToolCall } from "../domain/Plan.js"

/**
 * Whether a step needs a human before it runs, given the gear (ADR-002).
 *
 * - S0 advise and S1 draft produce no side effects, so a tool step is still gated: at these gears
 *   METIS is not supposed to execute anything at all.
 * - S2 sandbox run executes in isolation with no external effect — no gate.
 * - S3 gated run is *defined* by requiring approval.
 * - S4 scheduled autonomy runs without one; the gate there is policy and the trust ledger, not a
 *   prompt, because there is nobody watching at the time it fires.
 *
 * Non-tool steps (`ask`, `decision`) never require approval — they have no effect to approve.
 */
export const stepRequiresApproval = (kind: PlanStep["kind"], autonomy: Autonomy): boolean => {
  if (kind !== "tool" && kind !== "write") return false
  switch (autonomy) {
    case "S0":
    case "S1":
    case "S3":
      return true
    case "S2":
    case "S4":
      return false
  }
}

interface StepTemplate {
  readonly kind: PlanStep["kind"]
  readonly description: string
  readonly capability?: string
  readonly input?: Record<string, unknown>
}

interface Template {
  readonly name: string
  readonly matches: (goal: string) => boolean
  readonly steps: (intent: Intent) => ReadonlyArray<StepTemplate>
  readonly assumptions: ReadonlyArray<string>
  readonly risks: ReadonlyArray<string>
  readonly expects: ReadonlyArray<{ kind: ArtifactExpectation["kind"]; description: string }>
}

const TEMPLATES: ReadonlyArray<Template> = [
  {
    name: "prd",
    matches: (goal) => /\bprd\b|product requirements/i.test(goal),
    steps: (intent) => [
      {
        kind: "tool",
        description: "Search for prior art and related work",
        capability: "research.search@0.1",
        input: { query: intent.goal }
      },
      {
        kind: "tool",
        description: "Draft the PRD",
        capability: "design.prd@1.0",
        input: { title: intent.goal }
      }
    ],
    assumptions: ["Public web sources are acceptable for this document"],
    risks: ["Sources may be stale or contradictory"],
    expects: [{ kind: "text", description: "PRD markdown" }]
  },
  {
    name: "c4",
    matches: (goal) => /\bc4\b|architecture diagram/i.test(goal),
    steps: (intent) => [
      {
        kind: "tool",
        description: "Draw the C4 context and container diagrams",
        capability: "design.c4@1.0",
        input: { title: intent.goal }
      }
    ],
    assumptions: ["The goal names the system well enough to diagram it"],
    risks: ["Containers are inferred from the goal alone and may not match the real system"],
    expects: [{ kind: "text", description: "C4 diagrams as Mermaid" }]
  },
  {
    name: "api_spec",
    matches: (goal) => /\bapi spec|\bopenapi\b/i.test(goal),
    steps: (intent) => [
      {
        kind: "tool",
        description: "Write the API specification",
        capability: "design.api_spec@1.0",
        input: { title: intent.goal }
      }
    ],
    assumptions: ["Endpoints can be inferred from the goal"],
    risks: ["Endpoints are inferred, not supplied, and need review"],
    expects: [{ kind: "text", description: "OpenAPI document" }]
  },
  {
    name: "research",
    matches: (goal) => /research|survey|literature|compare|state of the art/i.test(goal),
    steps: (intent) => [
      {
        kind: "tool",
        description: "Search for sources",
        capability: "research.search@0.1",
        input: { query: intent.goal }
      }
    ],
    assumptions: ["The question is answerable from public sources"],
    risks: ["Retrieval may miss the most relevant work"],
    expects: [{ kind: "text", description: "Summary with citations" }]
  }
]

/**
 * The fallback. A goal the planner does not recognise becomes a question rather than a guess —
 * inventing tool calls for an unrecognised intent is how a planner does something surprising.
 */
const CLARIFY: Template = {
  name: "clarify",
  matches: () => true,
  steps: () => [
    { kind: "ask", description: "Ask the user what specifically they want produced" }
  ],
  assumptions: [],
  risks: ["The intent was not understood well enough to plan against"],
  expects: []
}

export const templateFor = (goal: string): Template => TEMPLATES.find((t) => t.matches(goal)) ?? CLARIFY

export class Planner extends Context.Tag("orchestrator/Planner")<Planner, {
  readonly plan: (intent: Intent) => Effect.Effect<Plan>
}>() {}

/**
 * A planner that plans only what can run.
 *
 * A step naming a capability `available` rejects is left out and recorded as a risk on the plan,
 * so the gap is visible to whoever reads the plan rather than surfacing as a failed step halfway
 * through executing it. If that leaves nothing to run, the plan asks instead, carrying the same
 * risks. `available` answers for capability ids only: the planner still never names a tool.
 */
export const makeFor = (available: (capability: string) => boolean) =>
  Planner.of({
    plan: (intent) =>
      Effect.gen(function*() {
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const now = Math.floor(millis / 1000) as EpochSeconds
        const matched = templateFor(intent.goal)

        const proposed = matched.steps(intent)
        const runnable = proposed.filter((step) => step.capability === undefined || available(step.capability))
        const skipped = proposed
          .filter((step) => step.capability !== undefined && !available(step.capability))
          .map((step) => `Skipped "${step.description}": ${step.capability} has no registered implementation`)

        const template = runnable.length > 0 ? matched : CLARIFY
        const risks = [...template.risks, ...skipped]

        const steps = (runnable.length > 0 ? runnable : CLARIFY.steps(intent)).map((step, index) =>
          new PlanStep({
            id: uuidv7(millis + index) as PlanStepId,
            kind: step.kind,
            description: step.description,
            requiresApproval: stepRequiresApproval(step.kind, intent.autonomy),
            ...(step.capability !== undefined
              ? {
                toolCall: new ToolCall({
                  capability: step.capability as CapabilityId,
                  input: step.input ?? {}
                  // `tool` is deliberately absent: ADR-017 requires the planner to target a
                  // capability and never name an implementation. The registry fills it at dispatch.
                })
              }
              : {})
          })
        )

        return new Plan({
          id: uuidv7(millis) as PlanId,
          intentId: intent.id,
          createdAt: now,
          steps: steps as unknown as readonly [PlanStep, ...Array<PlanStep>],
          assumptions: template.assumptions.map((description, i) =>
            new Assumption({ id: uuidv7(millis + i) as AssumptionId, description, tags: [] })
          ),
          risks: risks.map((description, i) => new Risk({ id: uuidv7(millis + i) as RiskId, description, tags: [] })),
          expectedArtifacts: template.expects.map((expectation, i) =>
            new ArtifactExpectation({
              id: uuidv7(millis + i) as ArtifactExpectationId,
              kind: expectation.kind,
              description: expectation.description,
              tags: []
            })
          ),
          artifacts: []
        })
      })
  })

/** Plans as though every capability were available. */
export const make = makeFor(() => true)

export const layer = Layer.succeed(Planner, make)

/** A planner over the capabilities a registry can actually resolve. */
export const layerFor = (available: (capability: string) => boolean) => Layer.succeed(Planner, makeFor(available))
