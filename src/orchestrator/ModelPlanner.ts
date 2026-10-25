/**
 * Planning with the model, for goals no template matches.
 *
 * Templates plan only what they were written for, and everything else used to come back as a
 * question. With a model configured, such a goal is planned from the capabilities the registry
 * actually holds: the model is shown each one's input contract, and proposes steps.
 *
 * The proposal is checked here before it becomes a plan, so the model's word is never taken for
 * it: every step must name a registered capability, its input must fit that capability's schema
 * (fields bound from an earlier step's output count as given), and a binding may only take from an
 * earlier step and a field that step declares. A failing proposal goes back once with what failed;
 * a second failure, like a model that cannot be reached, falls back to the planner's other paths
 * with the reason recorded as a risk.
 *
 * The model sees the goal, which the user wrote, and never the text pasted with it, which could be
 * anyone's: it learns only that a paste exists, and writes `{{pasted}}` where it belongs. The paste
 * goes into the steps afterwards, as data carrying its labels, so it cannot steer the plan.
 * Everything the plan does still passes policy, approval and the trust gate at execution.
 */

import { Effect, Either, Schema } from "effect"

import type { Intent } from "../domain/Intent.js"
import * as JsonPointer from "../domain/JsonPointer.js"
import type { ToolSpec } from "../domain/ToolSpec.js"
import type { Turn } from "../tools/Model.js"
import { fill } from "./Placeholders.js"

/** The most steps a proposed plan may have. */
const MAX_STEPS = 5
const ATTEMPTS = 2

export const SYSTEM = [
  "You are the planner of METIS, a personal copilot. Turn the user's goal into a short plan of tool",
  "calls, using only the capabilities listed in <capabilities>, each with the input schema it accepts.",
  `Use as few steps as the goal needs, at most ${MAX_STEPS}. A step's input must fit its capability's`,
  "schema exactly: required fields present, no fields the schema does not list. To pass one step's",
  "output into a later step's input, add a binding {\"to\": \"/inputField\", \"fromStep\": <earlier",
  "step's index, from 0>, \"from\": \"/outputField\"} and leave that input field out. If the user",
  "pasted text with the goal, you cannot see it: write the exact string {{pasted}} where it belongs.",
  "If the goal cannot be done with these capabilities, or is too unclear to plan, ask one question",
  "instead. Reply with JSON only, no prose and no code fence, in one of two shapes:",
  "{\"steps\": [{\"description\": \"...\", \"capability\": \"...\", \"input\": {...}, \"bindings\": [...]}],",
  "\"assumptions\": [\"...\"], \"risks\": [\"...\"]} or {\"ask\": \"...\"}."
].join(" ")

type JsonSchema = Record<string, unknown>

const props = (schema: JsonSchema | undefined): Record<string, JsonSchema> =>
  (schema?.properties ?? {}) as Record<string, JsonSchema>

/** One capability as the model is shown it: what it is, the input it takes, the fields it returns. */
const describe = (spec: ToolSpec): string => {
  const input = { ...(spec.inputSchema ?? {}) }
  for (const key of ["$schema", "$id", "examples"]) delete input[key]
  const output = spec.outputSchema
  return [
    `- ${spec.capability}${input.title !== undefined ? `: ${String(input.title)}` : ""}`,
    `  input schema: ${JSON.stringify(input)}`,
    `  output fields: ${Object.keys(props(output)).join(", ") || "(none declared)"}${
      typeof output?.description === "string" ? `. ${output.description}` : ""
    }`
  ].join("\n")
}

/** One spec per capability: the first the registry would choose. */
const catalogueOf = (specs: ReadonlyArray<ToolSpec>): Array<ToolSpec> => {
  const seen = new Map<string, ToolSpec>()
  for (const spec of specs) if (!seen.has(spec.capability)) seen.set(spec.capability, spec)
  return [...seen.values()]
}

export const request = (goal: string, pasted: boolean, specs: ReadonlyArray<ToolSpec>): string =>
  [
    `<goal>\n${goal}\n</goal>`,
    pasted ? "The user pasted text with this goal. You cannot see it: refer to it as {{pasted}}." : "",
    `<capabilities>\n${catalogueOf(specs).map(describe).join("\n")}\n</capabilities>`
  ].filter((part) => part !== "").join("\n")

const Pointer = Schema.String.pipe(Schema.pattern(/^(\/([^~/]|~[01])*)+$/))
const ProposedStep = Schema.Struct({
  description: Schema.NonEmptyString,
  capability: Schema.String,
  input: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), { default: () => ({}) }),
  bindings: Schema.optionalWith(
    Schema.Array(Schema.Struct({ to: Pointer, fromStep: Schema.Int.pipe(Schema.nonNegative()), from: Pointer })),
    { default: () => [] }
  )
})
const Proposal = Schema.Union(
  Schema.Struct({ ask: Schema.NonEmptyString }),
  Schema.Struct({
    steps: Schema.NonEmptyArray(ProposedStep),
    assumptions: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
    risks: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] })
  })
)
export type Proposal = typeof Proposal.Type

/** The proposal in the model's answer, or why there is none. A stray code fence is forgiven. */
export const parse = (text: string): Proposal | { readonly error: string } => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return { error: "the answer is not JSON" }
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { error: "the answer is not valid JSON" }
  }
  const decoded = Schema.decodeUnknownEither(Proposal)(json)
  return Either.isRight(decoded)
    ? decoded.right
    : { error: "the JSON is neither {\"steps\": [...]} nor {\"ask\": \"...\"} as described" }
}

const TYPES: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: Array.isArray,
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v)
}

/** The top-level field a pointer names: `/query` and `/query/0` both name `query`. */
const head = (pointer: string): string => pointer.split("/")[1]!.replaceAll("~1", "/").replaceAll("~0", "~")

/** What is wrong with `proposal` as a plan over `specs`. Empty is a pass. */
export const findings = (proposal: Proposal, specs: ReadonlyArray<ToolSpec>, pasted: boolean): Array<string> => {
  if ("ask" in proposal) return []
  const found: Array<string> = []
  const byCapability = new Map(catalogueOf(specs).map((spec) => [spec.capability as string, spec]))
  if (proposal.steps.length > MAX_STEPS) {
    found.push(`the plan has ${proposal.steps.length} steps, more than ${MAX_STEPS}`)
  }
  proposal.steps.forEach((step, index) => {
    const where = `step ${index} (${step.capability})`
    const spec = byCapability.get(step.capability)
    if (spec === undefined) {
      found.push(`${where} names a capability that is not listed`)
      return
    }
    const schema = spec.inputSchema
    const declared = props(schema)
    const bound = new Set(step.bindings.map((binding) => head(binding.to)))
    const targets = new Set<string>()
    for (const binding of step.bindings) {
      // The plan's own rule (`bindingProblem`): a bound value goes where the input leaves room.
      if (targets.has(binding.to)) found.push(`${where} binds ${binding.to} twice`)
      targets.add(binding.to)
      if (!JsonPointer.settable(step.input, binding.to as JsonPointer.JsonPointer)) {
        found.push(
          `${where} binds ${binding.to}, which its input has no place for: give the input the containers the pointer goes through, such as an array with an object in it`
        )
      }
      if (binding.fromStep >= index) {
        found.push(`${where} binds from step ${binding.fromStep}, which does not come before it`)
        continue
      }
      const source = byCapability.get(proposal.steps[binding.fromStep]!.capability)
      const fields = Object.keys(props(source?.outputSchema))
      if (source !== undefined && fields.length > 0 && !fields.includes(head(binding.from))) {
        found.push(`${where} binds ${binding.from}, which step ${binding.fromStep} does not return`)
      }
    }
    for (const field of (schema?.required ?? []) as Array<string>) {
      if (!(field in step.input) && !bound.has(field)) found.push(`${where} is missing required input "${field}"`)
    }
    for (const [field, value] of Object.entries(step.input)) {
      const type = declared[field]?.type
      if (declared[field] === undefined) {
        if (schema?.additionalProperties === false) {
          found.push(`${where} has input "${field}", which its schema does not list`)
        }
      } else if (typeof type === "string" && TYPES[type] !== undefined && !TYPES[type]!(value)) {
        found.push(`${where} input "${field}" should be ${type}`)
      }
    }
    if (!pasted && JSON.stringify(step.input).includes("{{pasted}}")) {
      found.push(`${where} uses {{pasted}}, but nothing was pasted`)
    }
  })
  return found
}

/** A checked proposal as the steps, assumptions and risks the planner builds a plan from. */
export interface Planned {
  readonly steps: ReadonlyArray<{
    readonly kind: "tool" | "ask"
    readonly description: string
    readonly capability?: string
    readonly input?: Record<string, unknown>
    readonly bindings?: ReadonlyArray<{ readonly to: string; readonly fromStep: number; readonly from: string }>
  }>
  readonly assumptions: ReadonlyArray<string>
  readonly risks: ReadonlyArray<string>
}

const planned = (proposal: Proposal, intent: Intent, pasted: string | undefined): Planned =>
  "ask" in proposal
    ? { steps: [{ kind: "ask", description: proposal.ask }], assumptions: [], risks: [] }
    : {
      steps: proposal.steps.map((step) => ({
        kind: "tool" as const,
        description: step.description,
        capability: step.capability,
        input: fill(step.input, intent.goal, pasted ?? "") as Record<string, unknown>,
        ...(step.bindings.length > 0 ? { bindings: step.bindings } : {})
      })),
      assumptions: proposal.assumptions,
      risks: ["Planned by the model from the goal: read the steps before approving them", ...proposal.risks]
    }

/**
 * A plan for `intent` from the model, checked; or why there is none, for the planner to record
 * as it falls back.
 */
export const planWithModel = (
  intent: Intent,
  pasted: string | undefined,
  specs: ReadonlyArray<ToolSpec>,
  complete: (system: string, turns: ReadonlyArray<Turn>) => Effect.Effect<string, { readonly message: string }>
): Effect.Effect<Either.Either<Planned, string>> =>
  Effect.gen(function*() {
    const turns: Array<Turn> = [{ role: "user", text: request(intent.goal, pasted !== undefined, specs) }]
    let failure = ""
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const answered = yield* Effect.either(complete(SYSTEM, turns))
      if (Either.isLeft(answered)) return Either.left(`the model could not plan: ${answered.left.message}`)
      const proposal = parse(answered.right)
      const wrong = "error" in proposal ? [proposal.error] : findings(proposal, specs, pasted !== undefined)
      if (wrong.length === 0) return Either.right(planned(proposal as Proposal, intent, pasted))
      failure = wrong.join("; ")
      turns.push(
        { role: "assistant", text: answered.right },
        { role: "user", text: `That plan fails: ${failure}. Reply with a corrected plan, JSON only.` }
      )
    }
    return Either.left(`the model's plan failed its check: ${failure}`)
  })
