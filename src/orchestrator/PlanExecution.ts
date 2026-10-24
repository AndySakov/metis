/**
 * Submitting a plan for execution.
 *
 * Two implementations, and the difference between them is the whole durability story:
 *
 * - **`restate`** hands the plan to a Restate workflow. Retries, checkpointing and suspension are
 *   Restate's; the run survives a process restart and an approval parks it rather than ending it.
 * - **`direct`** runs the executor in-process. Identical policy behaviour, no durability at all —
 *   killing the process loses the run.
 *
 * Both are offered because the honest alternative to "Restate is running" is not "silently
 * degrade": it is a caller that knows which mode it got. `submit` reports the mode it used, so a
 * plan run without durability cannot be mistaken for one that has it.
 */

import * as restate from "@restatedev/restate-sdk"
import { Cause, Context, Effect, Exit, Layer, Runtime, Schedule, Schema } from "effect"
import type { ServerHttp2Session } from "node:http2"
import { createServer } from "node:http2"

import { uuidv7 } from "../domain/Ids.js"
import { Intent } from "../domain/Intent.js"
import type { PlanStepId } from "../domain/Plan.js"
import { Plan } from "../domain/Plan.js"
import type { ArtifactStore } from "../mneme/ArtifactStore.js"
import type { EventLogStore } from "../mneme/EventLogStore.js"
import type { PolicyGate } from "../policy/PolicyGate.js"
import type { TrustLedger } from "../policy/TrustLedger.js"
import type { Sampler } from "../policy/Verification.js"
import type { ToolRegistry } from "../tools/ToolRegistry.js"
import type { ToolRunner } from "../tools/ToolRunner.js"
import { execute } from "./Executor.js"
import type { ExecutionReport } from "./Executor.js"
import { planWorkflow } from "./PlanWorkflow.js"

export type ExecutionMode = "restate" | "direct"

export interface Submission {
  readonly executionId: string
  /** Which path ran it. `direct` means the run is **not** durable. */
  readonly mode: ExecutionMode
  /** Present for `direct`, which completes synchronously. Absent for `restate`, which is async. */
  readonly report?: ExecutionReport
}

export class PlanExecutionError extends Error {
  readonly _tag = "PlanExecutionError"
}

export class PlanExecution extends Context.Tag("orchestrator/PlanExecution")<PlanExecution, {
  readonly submit: (
    intent: Intent,
    plan: Plan,
    approvedSteps?: ReadonlyArray<PlanStepId>
  ) => Effect.Effect<Submission, PlanExecutionError>
}>() {}

const post = (url: string, body: unknown, what: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
      if (!response.ok) throw new Error(`restate ingress returned ${response.status}`)
    },
    catch: (cause) => new PlanExecutionError(`cannot ${what}: ${String(cause)}`)
  })

/**
 * Submits to a running Restate ingress.
 *
 * Uses the `/send` form because the workflow is expected to suspend on an approval; a synchronous
 * call would block until the human answered.
 */
export const make = (ingressUrl: string) =>
  PlanExecution.of({
    submit: (intent, plan, approvedSteps) =>
      Effect.gen(function*() {
        // The plan id keys the workflow, which makes submission idempotent: submitting the same
        // plan twice attaches to the existing run (Restate answers `PreviouslyAccepted`) rather
        // than starting a second one. So a resubmission carrying approvals is safe to send whole.
        const key = plan.id
        yield* post(`${ingressUrl}/plan/${key}/run/send`, { intent, plan }, "submit plan to Restate")

        // An approval releases the step the workflow is parked on. Resolving a promise the workflow
        // has not reached yet is fine too: the resolution is durable and waits for it.
        for (const stepId of approvedSteps ?? []) {
          yield* post(`${ingressUrl}/plan/${key}/approve`, { stepId, granted: true }, "approve step in Restate")
        }

        return { executionId: key, mode: "restate" as const }
      })
  })

export const restateLayer = (ingressUrl: string) => Layer.succeed(PlanExecution, make(ingressUrl))

export interface RestateOptions {
  readonly ingressUrl: string
  readonly adminUrl: string
  /** Where this process serves the plan workflow. */
  readonly endpointPort: number
  /** How Restate reaches that endpoint; defaults to loopback on `endpointPort`. */
  readonly endpointUrl?: string | undefined
}

/**
 * Durable execution with the workflow served from this process.
 *
 * Serves `planWorkflow` on an HTTP/2 server owned by this layer's scope, registers it with the
 * Restate server's admin API, and submits through the ingress. The workflow's `execute` runs the
 * same executor `directLayer` does, through this runtime, so policy, trust and the event log are
 * the ones the rest of METIS sees; only the scheduling moves to Restate (ADR-016).
 */
export const servedRestateLayer = (options: RestateOptions) =>
  Layer.scoped(
    PlanExecution,
    Effect.gen(function*() {
      const runtime = yield* Effect.runtime<
        PolicyGate | EventLogStore | ArtifactStore | ToolRegistry | ToolRunner | TrustLedger | Sampler
      >()

      const workflow = planWorkflow({
        execute: (intent, plan, approved) => {
          // Restate hands back the JSON the plan was submitted as. Decoded here, a payload that does
          // not decode is terminal: retrying cannot make it valid.
          const decoded = Effect.all([Schema.decodeUnknown(Intent)(intent), Schema.decodeUnknown(Plan)(plan)]).pipe(
            Effect.mapError((cause) => new restate.TerminalError(`malformed plan run: ${String(cause)}`))
          )
          // Thrown unwrapped, so Restate sees a TerminalError as one rather than retrying it.
          return Runtime.runPromiseExit(runtime)(
            Effect.flatMap(decoded, ([i, p]) => execute(i, p, { approvedSteps: approved }))
          ).then((exit) => {
            if (Exit.isSuccess(exit)) return exit.value
            throw Cause.squash(exit.cause)
          })
        }
      })

      const server = createServer(restate.createEndpointHandler({ services: [workflow] }))
      // Restate holds its HTTP/2 connection open, and `close` waits for every session to end, so
      // shutdown closes them itself rather than waiting on a peer that will not hang up.
      const sessions = new Set<ServerHttp2Session>()
      server.on("session", (session) => {
        sessions.add(session)
        session.on("close", () => sessions.delete(session))
      })
      yield* Effect.async<void>((resume) => {
        server.listen(options.endpointPort, "127.0.0.1", () => resume(Effect.void))
      })
      yield* Effect.addFinalizer(() =>
        Effect.async<void>((resume) => {
          server.close(() => resume(Effect.void))
          for (const session of sessions) session.close()
        })
      )

      // Register (or re-register) the endpoint, retrying while the Restate server comes up.
      const endpointUrl = options.endpointUrl ?? `http://127.0.0.1:${options.endpointPort}`
      yield* Effect.tryPromise(async () => {
        const response = await fetch(`${options.adminUrl}/deployments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uri: endpointUrl, force: true })
        })
        if (!response.ok) throw new Error(`restate admin returned ${response.status}`)
      }).pipe(
        Effect.retry(Schedule.spaced("500 millis").pipe(Schedule.upTo("60 seconds"))),
        Effect.orDieWith((cause) => new Error(`cannot register with Restate at ${options.adminUrl}: ${String(cause)}`))
      )

      return make(options.ingressUrl)
    })
  )

/**
 * Runs the executor in-process.
 *
 * Not durable, and says so in every submission it returns.
 */
export const directLayer = Layer.effect(
  PlanExecution,
  Effect.gen(function*() {
    const context = yield* Effect.context<
      PolicyGate | EventLogStore | ArtifactStore | ToolRegistry | ToolRunner | TrustLedger | Sampler
    >()

    return PlanExecution.of({
      submit: (intent, plan, approvedSteps) =>
        execute(intent, plan, { approvedSteps: approvedSteps ?? [] }).pipe(
          Effect.provide(context),
          Effect.map((report) => ({ executionId: uuidv7(), mode: "direct" as const, report }))
        )
    })
  })
)
