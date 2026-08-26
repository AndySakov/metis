import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"

import { Artifact, ArtifactId } from "../domain/Artifact.js"
import { IntentDraft } from "../domain/Intent.js"
import { Plan, PlanId, PlanStepId } from "../domain/Plan.js"

export class IntentParsingError extends Schema.TaggedError<IntentParsingError>()("IntentParsingError", {
  message: Schema.String,
  info: Schema.Unknown
}) {}

export class PlanNotFound extends Schema.TaggedError<PlanNotFound>()("PlanNotFound", {
  id: PlanId
}) {}

export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()("ArtifactNotFound", {
  id: ArtifactId
}) {}

export class ExecutionRejected extends Schema.TaggedError<ExecutionRejected>()("ExecutionRejected", {
  id: PlanId,
  message: Schema.String
}) {}

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
export class ExecutionAccepted extends Schema.Class<ExecutionAccepted>("ExecutionAccepted")({
  executionId: Schema.String,
  mode: Schema.Literal("restate", "direct"),
  status: Schema.Literal("accepted", "completed", "awaiting_approval", "denied", "failed")
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
{}

export class IntentApi extends HttpApi.make("api").add(IntentApiGroup) {}
