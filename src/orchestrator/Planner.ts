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
import type { JsonPointer } from "../domain/JsonPointer.js"
import type { ArtifactExpectationId, AssumptionId, PlanId, PlanStepId, RiskId } from "../domain/Plan.js"
import { ArtifactExpectation, Assumption, InputBinding, Plan, PlanStep, Risk, ToolCall } from "../domain/Plan.js"

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
  /** Input filled from an earlier step of the same template, named by its index there. */
  readonly bindings?: ReadonlyArray<{ readonly to: string; readonly fromStep: number; readonly from: string }>
}

interface Template {
  readonly name: string
  readonly matches: (goal: string) => boolean
  readonly steps: (intent: Intent) => ReadonlyArray<StepTemplate>
  readonly assumptions: ReadonlyArray<string>
  readonly risks: ReadonlyArray<string>
  readonly expects: ReadonlyArray<{ kind: ArtifactExpectation["kind"]; description: string }>
}

/**
 * What a document is about, taken from the goal: the text after the request phrase, without a
 * leading connective or article, first letter capitalised. "Draft a PRD for an offline-first notes
 * app" is titled "Offline-first notes app". A goal with nothing after the phrase is its own title,
 * since a guessed title is worse than the user's words.
 */
export const subjectOf = (goal: string, request: RegExp): string => {
  const match = request.exec(goal)
  if (match === null) return goal
  const subject = goal
    .slice(match.index + match[0].length)
    .replace(/^[\s:,-]*(?:(?:for|of|about|on|covering)\s+)?(?:(?:a|an|the)\s+)?/i, "")
    .replace(/[\s.!?]+$/, "")
  return subject === "" ? goal : subject[0]!.toUpperCase() + subject.slice(1)
}

const PRD_REQUEST = /\bprd\b|product requirements(?: document)?/i
const C4_REQUEST = /\bc4\b(?: diagrams?)?|architecture diagrams?/i
const API_REQUEST = /\bapi spec(?:ification)?|\bopenapi\b(?: spec(?:ification)?)?/i

const SCAFFOLD_REQUEST =
  /\b(?:scaffold|bootstrap)\b(?:\s+(?:a|an|the))?(?:\s+new)?(?:\s+(?:typescript|ts|node(?:\.js)?|python))?(?:\s+(?:project|app|service|repo|package|library|cli))?/i

/**
 * The directory name for a project, taken from the goal: what follows "called" or "named" if the
 * goal says, otherwise its subject. Lowercased and hyphenated to the single path segment
 * `build.scaffold` accepts, so a derived name is never the reason the tool refuses.
 */
export const projectNameOf = (goal: string): string => {
  const named = /\b(?:called|named)\s+["'`]?([^\s"'`]+)/i.exec(goal)?.[1]
  const subject = subjectOf(goal, SCAFFOLD_REQUEST)
  const source = named ?? (subject === goal ? "" : subject)
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  if (slug === "") return "new-project"
  return (/^[a-z]/.test(slug) ? slug : `app-${slug}`).slice(0, 63).replace(/-+$/, "")
}

/**
 * Text the user pasted alongside the goal, from the intent input named `pasted`. Where it came
 * from is whatever its tags say; the console tags it `untrusted`, since a group chat is anyone's.
 */
export const pastedOf = (intent: Intent): string | undefined => {
  const value = intent.inputs.find((input) => input.name === "pasted")?.value
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/**
 * The first http(s) URL in a goal, without punctuation that ends the sentence around it. A closing
 * bracket is kept when the URL opened it, as in `https://en.wikipedia.org/wiki/Metis_(mythology)`.
 */
export const urlIn = (goal: string): string | undefined => {
  let url = /\bhttps?:\/\/[^\s<>"'`]+/i.exec(goal)?.[0]
  if (url === undefined) return undefined
  for (;;) {
    const last = url.at(-1)!
    const unbalanced = (open: string, close: string) =>
      last === close && url!.split(close).length > url!.split(open).length
    if (/[.,;:!?]/.test(last) || unbalanced("(", ")") || unbalanced("[", "]")) url = url.slice(0, -1)
    else return url
  }
}

const TEMPLATES: ReadonlyArray<Template> = [
  {
    // First, so "summarize the PRD at https://..." reads the page rather than drafting a new PRD.
    name: "summarize_url",
    matches: (goal) => /\b(?:summari[sz]e|summary of|tl;?dr|digest)\b/i.test(goal) && urlIn(goal) !== undefined,
    steps: (intent) => {
      const url = urlIn(intent.goal)!
      return [
        { kind: "tool", description: "Fetch the page", capability: "research.fetch@0.1", input: { url } },
        {
          kind: "tool",
          description: "Summarize what was fetched",
          capability: "research.summarize@0.1",
          input: { chunks: [{ source: url }] },
          // The page text is only known once it is fetched; it arrives tagged as web content.
          bindings: [{ to: "/chunks/0/text", fromStep: 0, from: "/text" }]
        }
      ]
    },
    assumptions: ["The page can be read without signing in"],
    risks: ["The page is untrusted: the summary repeats what it says, not what is true"],
    expects: [{ kind: "text", description: "The page, and a summary of it" }]
  },
  {
    name: "prd",
    matches: (goal) => PRD_REQUEST.test(goal),
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
        // The whole goal goes along as context, so trimming it to a title loses nothing.
        input: { title: subjectOf(intent.goal, PRD_REQUEST), context: intent.goal }
      }
    ],
    assumptions: ["Public web sources are acceptable for this document"],
    risks: ["Sources may be stale or contradictory"],
    expects: [{ kind: "text", description: "PRD markdown" }]
  },
  {
    name: "c4",
    matches: (goal) => C4_REQUEST.test(goal),
    steps: (intent) => [
      {
        kind: "tool",
        description: "Draw the C4 context and container diagrams",
        capability: "design.c4@1.0",
        input: { title: subjectOf(intent.goal, C4_REQUEST), description: intent.goal }
      }
    ],
    assumptions: ["The goal names the system well enough to diagram it"],
    risks: ["Containers are inferred from the goal alone and may not match the real system"],
    expects: [{ kind: "text", description: "C4 diagrams as Mermaid" }]
  },
  {
    name: "api_spec",
    matches: (goal) => API_REQUEST.test(goal),
    steps: (intent) => [
      {
        kind: "tool",
        description: "Write the API specification",
        // The contract has no free-text field, so the title is all the goal it carries.
        capability: "design.api_spec@1.0",
        input: { title: subjectOf(intent.goal, API_REQUEST) }
      }
    ],
    assumptions: ["Endpoints can be inferred from the goal"],
    risks: ["Endpoints are inferred, not supplied, and need review"],
    expects: [{ kind: "text", description: "OpenAPI document" }]
  },
  {
    // After the document templates, so "a PRD for a scaffold generator" is still a PRD.
    name: "scaffold",
    matches: (goal) => /\b(?:scaffold|bootstrap)\b/i.test(goal),
    steps: (intent) => [
      {
        kind: "tool",
        description: "Scaffold the project in the workspace",
        capability: "build.scaffold@0.1",
        input: { name: projectNameOf(intent.goal), stack: /\bpython\b/i.test(intent.goal) ? "python" : "node-ts" }
      }
    ],
    assumptions: ["The workspace is where the project should live"],
    risks: ["The project name is derived from the goal and may need renaming"],
    expects: [{ kind: "text", description: "The files created" }]
  },
  {
    // After the document and scaffold templates, so "a PRD for a leads dashboard" is still a PRD.
    name: "triage_leads",
    matches: (goal) => /\b(leads?|triage|enquir(?:y|ies)|sweep)\b/i.test(goal),
    steps: (intent) => {
      const pasted = pastedOf(intent)
      return pasted === undefined
        ? [{
          kind: "ask",
          description: "Paste the group chat to triage: export it from WhatsApp, or copy the messages"
        }]
        : [{
          kind: "tool",
          description: "Triage the pasted messages for leads",
          capability: "stays.triage@0.1",
          input: { messages: pasted }
        }]
    },
    assumptions: ["The pasted messages are recent enough that relative dates mean what they say today"],
    risks: ["Pasted messages are untrusted text: they are classified, never followed"],
    expects: [{ kind: "text", description: "Leads, best first, and what was dropped" }]
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
        // A step is left out if its capability is not available, or if a step it takes input from
        // was left out: it could only ever fail for want of that input.
        const kept: Array<boolean> = []
        const skipped: Array<string> = []
        for (const [index, step] of proposed.entries()) {
          const missing = step.capability !== undefined && !available(step.capability)
          const orphaned = (step.bindings ?? []).find((binding) => kept[binding.fromStep] !== true)
          kept[index] = !missing && orphaned === undefined
          if (missing) {
            skipped.push(`Skipped "${step.description}": ${step.capability} has no registered implementation`)
          } else if (orphaned !== undefined) {
            skipped.push(
              `Skipped "${step.description}": it needs the output of "${
                proposed[orphaned.fromStep]!.description
              }", which was skipped`
            )
          }
        }
        const runnable = proposed.flatMap((step, index) => kept[index] ? [{ step, index }] : [])

        const template = runnable.length > 0 ? matched : CLARIFY
        const risks = [...template.risks, ...skipped]

        const chosen = runnable.length > 0 ? runnable : CLARIFY.steps(intent).map((step, index) => ({ step, index }))
        const ids = new Map(chosen.map(({ index }, position) => [index, uuidv7(millis + position) as PlanStepId]))
        const steps = chosen.map(({ index, step }) =>
          new PlanStep({
            id: ids.get(index)!,
            kind: step.kind,
            description: step.description,
            requiresApproval: stepRequiresApproval(step.kind, intent.autonomy),
            ...(step.capability !== undefined
              ? {
                toolCall: new ToolCall({
                  capability: step.capability as CapabilityId,
                  input: step.input ?? {},
                  ...(step.bindings !== undefined
                    ? {
                      bindings: step.bindings.map((binding) =>
                        new InputBinding({
                          to: binding.to as JsonPointer,
                          fromStep: ids.get(binding.fromStep)!,
                          from: binding.from as JsonPointer
                        })
                      )
                    }
                    : {})
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
