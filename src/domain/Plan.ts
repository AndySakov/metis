/**
 * The plan a request turns into: an ordered list of steps, plus what the planner assumed, what it
 * thinks could go wrong, and what it expects to produce.
 */

import { Schema } from "effect"

import { ArtifactId } from "./Artifact.js"
import { ArtifactKind, Budget, CapabilityId, EpochSeconds, LongText, Tags, Uuid7 } from "./Common.js"
import { IntentId } from "./Intent.js"

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
export class Plan extends Schema.Class<Plan>("Plan")({
  id: PlanId,
  intentId: IntentId,
  createdAt: EpochSeconds,
  steps: Schema.NonEmptyArray(PlanStep),
  assumptions: Schema.optionalWith(Schema.Array(Assumption), { default: () => [] }),
  risks: Schema.optionalWith(Schema.Array(Risk), { default: () => [] }),
  expectedArtifacts: Schema.optionalWith(Schema.Array(ArtifactExpectation), { default: () => [] }),
  /** Identifiers of artifacts this plan actually produced. References, never embedded records. */
  artifacts: Schema.optionalWith(Schema.Array(ArtifactId), { default: () => [] })
}) {}
