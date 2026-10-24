/**
 * The plan a request turns into: an ordered list of steps, plus what the planner assumed, what it
 * thinks could go wrong, and what it expects to produce.
 */

import { Schema } from "effect"

import { ArtifactId } from "./Artifact.js"
import { ArtifactKind, Budget, CapabilityId, EpochSeconds, LongText, Tags, Uuid7 } from "./Common.js"
import { IntentId } from "./Intent.js"
import * as Pointer from "./JsonPointer.js"

export const PlanId = Uuid7.pipe(Schema.brand("PlanId"))
export type PlanId = typeof PlanId.Type

export const PlanStepId = Uuid7.pipe(Schema.brand("PlanStepId"))
export type PlanStepId = typeof PlanStepId.Type

export const AssumptionId = Uuid7.pipe(Schema.brand("AssumptionId"))
export type AssumptionId = typeof AssumptionId.Type

export const RiskId = Uuid7.pipe(Schema.brand("RiskId"))
export type RiskId = typeof RiskId.Type

export const ArtifactExpectationId = Uuid7.pipe(Schema.brand("ArtifactExpectationId"))
export type ArtifactExpectationId = typeof ArtifactExpectationId.Type

/**
 * One value of a tool call's input taken from an earlier step's output, resolved at dispatch.
 *
 * This is how a plan chains: fetch a page, then summarize what was fetched. The value carries its
 * source's trust labels with it, so content read from the open web reaches policy as `untrusted`
 * at every later step it flows into, rather than arriving as though the planner had written it.
 */
export class InputBinding extends Schema.Class<InputBinding>("InputBinding")({
  /** Where in this call's input the value goes. Its parent must exist in `input`; it must not. */
  to: Pointer.JsonPointer.pipe(Schema.minLength(1)),
  /** The step whose output supplies the value: an earlier tool step of the same plan. */
  fromStep: PlanStepId,
  /** Where in that step's output the value is read; `""` for the whole output. */
  from: Pointer.JsonPointer
}) {}

export class ToolCall extends Schema.Class<ToolCall>("ToolCall")({
  capability: CapabilityId,
  /**
   * The concrete implementation chosen to satisfy the capability. Set by the registry at dispatch,
   * never written by the planner — ADR-017 requires the planner to target capabilities and never
   * name an implementation. Present on an executed plan, absent on a freshly generated one.
   */
  tool: Schema.optional(Schema.NonEmptyTrimmedString),
  /** Validated at dispatch against the input schema the capability declares in `specs/capabilities/`. */
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  /** Input values filled from earlier steps' outputs when this call is dispatched. */
  bindings: Schema.optional(Schema.Array(InputBinding)),
  budget: Schema.optional(Budget)
}) {}

export class PlanStep extends Schema.Class<PlanStep>("PlanStep")({
  id: PlanStepId,
  kind: Schema.Literal("tool", "ask", "write", "decision"),
  description: LongText,
  requiresApproval: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  toolCall: Schema.optional(ToolCall)
}) {}

/**
 * Something the plan takes as true without checking.
 *
 * Carries an identifier so a decision or artifact can point at it — a bare string could not be
 * referenced, and ADR-001's provenance rules require that it can be.
 */
export class Assumption extends Schema.Class<Assumption>("Assumption")({
  id: AssumptionId,
  description: LongText,
  tags: Tags
}) {}

export class Risk extends Schema.Class<Risk>("Risk")({
  id: RiskId,
  description: LongText,
  tags: Tags
}) {}

/**
 * An artifact the plan intends to produce.
 *
 * Deliberately not an `Artifact`: it has no uri and no checksum because it does not exist yet, and
 * forcing the two shapes together is what produced the duplicate Artifact definition this replaces.
 */
export class ArtifactExpectation extends Schema.Class<ArtifactExpectation>("ArtifactExpectation")({
  id: ArtifactExpectationId,
  kind: ArtifactKind,
  description: LongText,
  tags: Tags
}) {}

/**
 * The always-visible plan.
 *
 * References its Intent by id rather than embedding it — embedding would duplicate state that has
 * its own row, its own identity and its own lifetime.
 */
/**
 * Why a plan's bindings cannot be resolved, or `undefined` if they all can. A binding must read from
 * an earlier tool step, so a plan cannot wait on itself or on a step that produces nothing, and it
 * must write somewhere its input leaves open, so a bound value never silently replaces one the
 * planner wrote.
 */
export const bindingProblem = (
  steps: ReadonlyArray<{ readonly id: string; readonly toolCall?: ToolCall | undefined }>
): string | undefined => {
  const earlier = new Set<string>()
  for (const [index, step] of steps.entries()) {
    const bound = new Set<string>()
    for (const binding of step.toolCall?.bindings ?? []) {
      if (bound.has(binding.to)) return `step ${index} binds ${binding.to} twice`
      bound.add(binding.to)
      if (!earlier.has(binding.fromStep)) {
        return `step ${index} binds ${binding.to} from ${binding.fromStep}, which is not an earlier tool step`
      }
      if (!Pointer.settable(step.toolCall!.input, binding.to)) {
        return `step ${index} binds ${binding.to}, which its input has no place for`
      }
      if (Pointer.get(step.toolCall!.input, binding.to) !== undefined) {
        return `step ${index} binds ${binding.to}, which its input already sets`
      }
    }
    if (step.toolCall !== undefined) earlier.add(step.id)
  }
  return undefined
}

export class Plan extends Schema.Class<Plan>("Plan")(
  Schema.Struct({
    id: PlanId,
    intentId: IntentId,
    createdAt: EpochSeconds,
    steps: Schema.NonEmptyArray(PlanStep),
    assumptions: Schema.optionalWith(Schema.Array(Assumption), { default: () => [] }),
    risks: Schema.optionalWith(Schema.Array(Risk), { default: () => [] }),
    expectedArtifacts: Schema.optionalWith(Schema.Array(ArtifactExpectation), { default: () => [] }),
    /** Identifiers of artifacts this plan actually produced. References, never embedded records. */
    artifacts: Schema.optionalWith(Schema.Array(ArtifactId), { default: () => [] })
  }).pipe(Schema.filter((plan) => bindingProblem(plan.steps)))
) {}
