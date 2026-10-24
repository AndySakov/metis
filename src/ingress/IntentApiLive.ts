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
import { Effect, Layer, Schema } from "effect"

import type { Artifact, ArtifactId } from "../domain/Artifact.js"
import type { EpochSeconds } from "../domain/Common.js"
import type { EventId, EventType } from "../domain/Event.js"
import { Event } from "../domain/Event.js"
import { uuidv7 } from "../domain/Ids.js"
import type { IntentId } from "../domain/Intent.js"
import { Intent } from "../domain/Intent.js"
import type { PlanId } from "../domain/Plan.js"
import { ArtifactStore } from "../mneme/ArtifactStore.js"
import { EventLogStore, EventQuery } from "../mneme/EventLogStore.js"
import { PlanStore } from "../mneme/PlanStore.js"
import { PlanExecution } from "../orchestrator/PlanExecution.js"
import { Planner } from "../orchestrator/Planner.js"
import { Packs } from "../packs/Packs.js"
import { TrustLedger } from "../policy/TrustLedger.js"
import { skillOf, skillsIn } from "../policy/TrustUpdater.js"
import { ToolRegistry } from "../tools/ToolRegistry.js"
import {
  ArtifactNotFound,
  ExecutionNotFound,
  ExecutionRecord,
  ExecutionRejected,
  IntentApi,
  PackSummary,
  PlanNotFound
} from "./IntentApi.js"

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
      .handle("getExecution", ({ path }) =>
        Effect.gen(function*() {
          const id = path.id as PlanId
          const plan = yield* Effect.orDie(plans.getPlan(id))
          if (plan === undefined) return yield* new PlanNotFound({ id })

          const finished = yield* Effect.orDie(log.read({ types: ["PLAN_FINISHED" as EventType] }))
          const latest = finished
            .filter((event) => (event.payload as { planId?: unknown } | null)?.planId === id)
            .at(-1)
          if (latest === undefined) return yield* new ExecutionNotFound({ id })

          // Decoded rather than cast: a payload the schema rejects is a defect in what the executor
          // wrote, and should surface as one rather than be served.
          const payload = latest.payload as { status?: unknown; steps?: unknown }
          return yield* Effect.orDie(
            Schema.decodeUnknown(ExecutionRecord)({
              status: payload.status,
              steps: payload.steps,
              finishedAt: latest.ts
            })
          )
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
            status: submission.report?.status ?? ("accepted" as const),
            ...(submission.report !== undefined
              ? {
                steps: submission.report.steps.map((step) => ({
                  stepId: step.stepId,
                  status: step.status,
                  ...(step.artifactId !== undefined ? { artifactId: step.artifactId } : {}),
                  ...(step.detail !== undefined ? { detail: step.detail } : {})
                }))
              }
              : {})
          }
        }))
      .handle("getArtifact", ({ path }) =>
        // `head`, not `get` — the endpoint returns metadata and must not move the payload (ADR-007).
        artifacts.head(path.id as ArtifactId).pipe(
          Effect.mapError(() => new ArtifactNotFound({ id: path.id as ArtifactId }))
        ) as Effect.Effect<Artifact, ArtifactNotFound>)
      .handle("getArtifactContent", ({ path }) =>
        Effect.gen(function*() {
          const id = path.id as ArtifactId
          // Existence first, so a missing artifact is a 404. Once it exists, a failed read is a
          // payload that did not match its checksum: a defect to surface, never bytes to serve and
          // never a "not found" that would hide the corruption.
          yield* artifacts.head(id).pipe(Effect.mapError(() => new ArtifactNotFound({ id })))
          const { payload } = yield* Effect.orDie(artifacts.get(id))
          return payload
        }))
  }))

export const InspectApiLive = HttpApiBuilder.group(IntentApi, "inspect", (handlers) =>
  Effect.gen(function*() {
    const log = yield* EventLogStore
    const registry = yield* ToolRegistry
    const ledger = yield* TrustLedger
    const packs = yield* Packs

    return handlers
      .handle("listTools", () => registry.all)
      .handle("listPacks", () =>
        Effect.succeed(packs.map((pack) =>
          new PackSummary({
            name: pack.manifest.name,
            version: pack.manifest.version,
            description: pack.manifest.description,
            capabilities: [...new Set(pack.tools.map((tool) => tool.capability))].sort(),
            examples: pack.manifest.examples
          })
        )))
      .handle("readEventLog", ({ urlParams }) =>
        Effect.gen(function*() {
          const { actor, fromTs, planId, toTs, types } = urlParams
          const window = new EventQuery({
            ...(fromTs !== undefined ? { fromTs } : {}),
            ...(toTs !== undefined ? { toTs } : {}),
            ...(actor !== undefined ? { actor } : {})
          })
          if (planId === undefined) {
            return yield* Effect.orDie(
              log.read(new EventQuery({ ...window, ...(types !== undefined ? { types } : {}) }))
            )
          }

          // A plan's events are the API's records of it, which name it, and everything its runs
          // wrote, which share each run's correlation id.
          const events = yield* Effect.orDie(log.read(window))
          const names = (event: Event) => (event.payload as { planId?: unknown } | null)?.planId === planId
          const runs = new Set(events.filter(names).flatMap((event) => event.correlationId ?? []))
          return events.filter((event) =>
            (names(event) || (event.correlationId !== undefined && runs.has(event.correlationId))) &&
            (types === undefined || types.includes(event.type))
          )
        }))
      .handle("listTrust", () =>
        Effect.gen(function*() {
          // Every skill METIS can run, and any it has history for that it no longer can.
          const registered = (yield* registry.all).map((spec) => skillOf(spec.capability))
          const recorded = skillsIn(yield* Effect.orDie(log.read({})))
          const skills = [...new Set([...registered, ...recorded])].sort()
          return yield* Effect.forEach(skills, (skill) => ledger.get(skill))
        }))
  }))

export const ApiLive = HttpApiBuilder.api(IntentApi).pipe(
  Layer.provide(IntentApiLive),
  Layer.provide(InspectApiLive)
)
