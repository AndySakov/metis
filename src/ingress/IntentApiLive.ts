/**
 * Handlers for the intent surface.
 *
 * `POST /intent` turns a draft into a recorded Intent and a Plan. The server assigns the intent's
 * id and timestamp — that is why the endpoint takes an `IntentDraft` and not an `Intent` (ADR-005).
 *
 * Both the intent and the plan are written to the event log before the plan is returned, so the
 * audit trail exists whether or not anyone ever executes it. A plan that was proposed and declined
 * is as much part of the record as one that ran.
 */

import { HttpApiBuilder } from "@effect/platform"
import { Effect, Layer } from "effect"

import type { Artifact, ArtifactId } from "../domain/Artifact.js"
import type { EpochSeconds } from "../domain/Common.js"
import type { EventId, EventType } from "../domain/Event.js"
import { Event } from "../domain/Event.js"
import { uuidv7 } from "../domain/Ids.js"
import type { IntentId } from "../domain/Intent.js"
import { Intent } from "../domain/Intent.js"
import type { PlanId } from "../domain/Plan.js"
import { ArtifactStore } from "../mneme/ArtifactStore.js"
import { EventLogStore } from "../mneme/EventLogStore.js"
import { PlanStore } from "../mneme/PlanStore.js"
import { PlanExecution } from "../orchestrator/PlanExecution.js"
import { Planner } from "../orchestrator/Planner.js"
import { ArtifactNotFound, ExecutionRejected, IntentApi, PlanNotFound } from "./IntentApi.js"

export const IntentApiLive = HttpApiBuilder.group(IntentApi, "intent", (handlers) =>
  Effect.gen(function*() {
    const planner = yield* Planner
    const log = yield* EventLogStore
    const artifacts = yield* ArtifactStore
    const plans = yield* PlanStore
    const execution = yield* PlanExecution

    const emit = (type: string, payload: unknown) =>
      Effect.gen(function*() {
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        yield* Effect.orDie(
          log.append(
            new Event({
              id: uuidv7() as EventId,
              ts: Math.floor(millis / 1000) as EpochSeconds,
              type: type as EventType,
              actor: "metis" as Intent["actor"],
              payload
            })
          )
        )
      })

    return handlers
      .handle("createPlan", ({ payload }) =>
        Effect.gen(function*() {
          const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

          const intent = new Intent({
            id: uuidv7(millis) as IntentId,
            ts: Math.floor(millis / 1000) as EpochSeconds,
            actor: payload.actor,
            goal: payload.goal,
            inputs: payload.inputs,
            constraints: payload.constraints,
            autonomy: payload.autonomy,
            ...(payload.description !== undefined ? { description: payload.description } : {})
          })

          yield* emit("INTENT_RECEIVED", { intentId: intent.id, autonomy: intent.autonomy })

          const plan = yield* planner.plan(intent)
          // Persisted before the plan is returned: a plan the caller has seen must be one the
          // system can still answer for after a restart.
          yield* Effect.orDie(plans.put(intent, plan))
          yield* emit("PLAN_CREATED", { planId: plan.id, intentId: intent.id, steps: plan.steps.length })

          return plan
        }))
      .handle("getPlan", ({ path }) =>
        Effect.gen(function*() {
          const plan = yield* Effect.orDie(plans.getPlan(path.id as PlanId))
          if (plan === undefined) return yield* new PlanNotFound({ id: path.id as PlanId })
          return plan
        }))
      .handle("executePlan", ({ path, payload }) =>
        Effect.gen(function*() {
          const plan = yield* Effect.orDie(plans.getPlan(path.id as PlanId))
          if (plan === undefined) return yield* new PlanNotFound({ id: path.id as PlanId })

          const intent = yield* Effect.orDie(plans.getIntent(plan.intentId))
          if (intent === undefined) {
            // A plan whose intent is missing cannot be executed: policy is evaluated against the
            // intent's actor, gear and input tags, and guessing any of them would mean running
            // under constraints nobody asked for.
            return yield* new ExecutionRejected({
              id: path.id as PlanId,
              message: "the plan's intent is missing, so policy cannot be evaluated against it"
            })
          }

          const submission = yield* execution.submit(intent, plan, payload.approvedSteps).pipe(
            Effect.mapError((cause) => new ExecutionRejected({ id: path.id as PlanId, message: cause.message }))
          )

          yield* emit("PLAN_SUBMITTED", {
            planId: plan.id,
            executionId: submission.executionId,
            mode: submission.mode
          })

          return {
            executionId: submission.executionId,
            mode: submission.mode,
            // `direct` completes synchronously and reports its real outcome; `restate` is async and
            // can only say it was accepted.
            status: submission.report?.status ?? ("accepted" as const)
          }
        }))
      .handle("getArtifact", ({ path }) =>
        // `head`, not `get` — the endpoint returns metadata and must not move the payload (ADR-007).
        artifacts.head(path.id as ArtifactId).pipe(
          Effect.mapError(() => new ArtifactNotFound({ id: path.id as ArtifactId }))
        ) as Effect.Effect<Artifact, ArtifactNotFound>)
  }))

export const ApiLive = HttpApiBuilder.api(IntentApi).pipe(Layer.provide(IntentApiLive))
