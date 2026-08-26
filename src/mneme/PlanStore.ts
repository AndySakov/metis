/**
 * Persistence for intents and the plans made from them.
 *
 * The two are stored together because a plan without its intent is a foreign-key violation and,
 * more to the point, an unanswerable record: "what was this plan for" is the first question anyone
 * asks of an audit trail.
 */

import { Context, Schema } from "effect"
import type { Effect } from "effect"

import type { Intent, IntentId } from "../domain/Intent.js"
import type { Plan, PlanId } from "../domain/Plan.js"

export class PlanStoreError extends Schema.TaggedError<PlanStoreError>()("PlanStoreError", {
  id: Schema.String,
  message: Schema.String
}) {}

export class PlanStore extends Context.Tag("mneme/PlanStore")<PlanStore, {
  /** Writes the intent and the plan atomically. Idempotent by id. */
  readonly put: (intent: Intent, plan: Plan) => Effect.Effect<void, PlanStoreError>
  readonly getPlan: (id: PlanId) => Effect.Effect<Plan | undefined, PlanStoreError>
  readonly getIntent: (id: IntentId) => Effect.Effect<Intent | undefined, PlanStoreError>
}>() {}
