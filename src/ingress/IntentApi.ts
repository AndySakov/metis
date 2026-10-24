import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

import { Artifact, ArtifactId } from "../domain/Artifact.js"
import { EpochSeconds } from "../domain/Common.js"
import { IntentDraft } from "../domain/Intent.js"
import { Plan, PlanId, PlanStepId } from "../domain/Plan.js"

// Each error carries the status `specs/api/openapi.yaml` declares for it. Without one, an error is
// served as 500, and `test/specs/ApiReconciliation.test.ts` fails on the mismatch.

export class IntentParsingError extends Schema.TaggedError<IntentParsingError>()("IntentParsingError", {
  message: Schema.String,
  info: Schema.Unknown
}, HttpApiSchema.annotations({ status: 422 })) {}

export class PlanNotFound extends Schema.TaggedError<PlanNotFound>()("PlanNotFound", {
  id: PlanId
}, HttpApiSchema.annotations({ status: 404 })) {}

export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()("ArtifactNotFound", {
  id: ArtifactId
}, HttpApiSchema.annotations({ status: 404 })) {}

/** The plan exists but cannot run as it stands, for instance because its intent is missing. */
export class ExecutionRejected extends Schema.TaggedError<ExecutionRejected>()("ExecutionRejected", {
  id: PlanId,
  message: Schema.String
}, HttpApiSchema.annotations({ status: 409 })) {}

export class ExecuteRequest extends Schema.Class<ExecuteRequest>("ExecuteRequest")({
  /** Steps the user has already approved. A gated step not named here parks the run. */
  approvedSteps: Schema.optionalWith(Schema.Array(PlanStepId), { default: () => [] })
}) {}

/**
 * The result of submitting a plan.
 *
 * `mode` is not decoration: `direct` means the run is **not** durable, and a caller that cannot
 * tell the two apart cannot know whether its plan survives a restart.
 */
/** What happened to one step, and the artifact it wrote, if any. */
export class StepOutcome extends Schema.Class<StepOutcome>("StepOutcome")({
  stepId: PlanStepId,
  status: Schema.Literal("completed", "awaiting_approval", "denied", "failed", "skipped"),
  artifactId: Schema.optional(ArtifactId),
  detail: Schema.optional(Schema.String)
}) {}

/** A plan with no run in the log yet. */
export class ExecutionNotFound extends Schema.TaggedError<ExecutionNotFound>()("ExecutionNotFound", {
  id: PlanId
}, HttpApiSchema.annotations({ status: 404 })) {}

/** A plan's latest run, as the event log recorded it. */
export class ExecutionRecord extends Schema.Class<ExecutionRecord>("ExecutionRecord")({
  status: Schema.Literal("completed", "awaiting_approval", "denied", "failed"),
  steps: Schema.Array(StepOutcome),
  finishedAt: EpochSeconds
}) {}

export class ExecutionAccepted extends Schema.Class<ExecutionAccepted>("ExecutionAccepted")({
  executionId: Schema.String,
  mode: Schema.Literal("restate", "direct"),
  status: Schema.Literal("accepted", "completed", "awaiting_approval", "denied", "failed"),
  /** Present when the run finished in-process; a `restate` submission has only been accepted. */
  steps: Schema.optional(Schema.Array(StepOutcome))
}) {}

/**
 * The intent surface.
 *
 * `POST /intent` takes an `IntentDraft`, not an `Intent`: the server assigns id and timestamp, so
 * requiring them from the client would be asking for fields it has no authority to set (ADR-005).
 * This definition is the one reconciled against `specs/api/openapi.yaml` in CI (ADR-011).
 */
export class IntentApiGroup extends HttpApiGroup.make("intent")
  .add(
    HttpApiEndpoint.post("createPlan", "/intent")
      .setPayload(IntentDraft)
      .addSuccess(Plan, { status: 201 })
      .addError(IntentParsingError)
  )
  .add(
    HttpApiEndpoint.get("getPlan", "/plans/:id")
      .setPath(Schema.Struct({ id: PlanId }))
      .addSuccess(Plan)
      .addError(PlanNotFound)
  )
  .add(
    HttpApiEndpoint.get("getExecution", "/plans/:id/execution")
      .setPath(Schema.Struct({ id: PlanId }))
      .addSuccess(ExecutionRecord)
      .addError(PlanNotFound)
      .addError(ExecutionNotFound)
  )
  .add(
    HttpApiEndpoint.post("executePlan", "/plans/:id/execute")
      .setPath(Schema.Struct({ id: PlanId }))
      .setPayload(ExecuteRequest)
      .addSuccess(ExecutionAccepted, { status: 202 })
      .addError(PlanNotFound)
      .addError(ExecutionRejected)
  )
  .add(
    HttpApiEndpoint.get("getArtifact", "/artifacts/:id")
      .setPath(Schema.Struct({ id: ArtifactId }))
      .addSuccess(Artifact)
      .addError(ArtifactNotFound)
  )
  .add(
    HttpApiEndpoint.get("getArtifactContent", "/artifacts/:id/content")
      .setPath(Schema.Struct({ id: ArtifactId }))
      .addSuccess(HttpApiSchema.Uint8Array())
      .addError(ArtifactNotFound)
  )
{}

export class IntentApi extends HttpApi.make("api").add(IntentApiGroup) {}
