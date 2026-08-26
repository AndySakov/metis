/**
 * In-memory `PlanStore`.
 *
 * The test double for the Postgres adapter. It does not persist across a restart and is not meant
 * to — anything that needs durability must be wired to `PostgresPlanStore`.
 */

import { Effect, Layer, Ref } from "effect"

import type { Intent, IntentId } from "../domain/Intent.js"
import type { Plan, PlanId } from "../domain/Plan.js"
import { PlanStore } from "./PlanStore.js"

export const make = Effect.gen(function*() {
  const plans = yield* Ref.make(new Map<string, Plan>())
  const intents = yield* Ref.make(new Map<string, Intent>())

  return PlanStore.of({
    // Idempotent by id, matching the Postgres adapter's ON CONFLICT DO NOTHING: writing the same
    // plan twice is one plan, and the first write wins.
    put: (intent, plan) =>
      Effect.gen(function*() {
        yield* Ref.update(intents, (current) =>
          current.has(intent.id) ? current : new Map(current).set(intent.id, intent))
        yield* Ref.update(plans, (current) =>
          current.has(plan.id) ? current : new Map(current).set(plan.id, plan))
      }),

    getPlan: (id: PlanId) => Effect.map(Ref.get(plans), (current) => current.get(id)),
    getIntent: (id: IntentId) => Effect.map(Ref.get(intents), (current) => current.get(id))
  })
})

export const layer = Layer.effect(PlanStore, make)
