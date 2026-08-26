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

import { Context, Effect, Layer } from "effect"

import { uuidv7 } from "../domain/Ids.js"
import type { Intent } from "../domain/Intent.js"
import type { Plan, PlanStepId } from "../domain/Plan.js"
import type { ArtifactStore } from "../mneme/ArtifactStore.js"
import type { EventLogStore } from "../mneme/EventLogStore.js"
import type { PolicyGate } from "../policy/PolicyGate.js"
import type { TrustLedger } from "../policy/TrustLedger.js"
import type { Sampler } from "../policy/Verification.js"
import type { ToolRegistry } from "../tools/ToolRegistry.js"
import type { ToolRunner } from "../tools/ToolRunner.js"
import { execute } from "./Executor.js"
import type { ExecutionReport } from "./Executor.js"

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

/**
 * Submits to a running Restate ingress.
 *
 * Uses the `/send` form because the workflow is expected to suspend on an approval; a synchronous
 * call would block until the human answered.
 */
export const restateLayer = (ingressUrl: string) =>
  Layer.succeed(
    PlanExecution,
    PlanExecution.of({
      submit: (intent, plan) =>
        Effect.gen(function*() {
          // The plan id keys the workflow, which makes submission idempotent: submitting the same
          // plan twice attaches to the existing run rather than starting a second one.
          const key = plan.id

          yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(`${ingressUrl}/plan/${key}/run/send`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ intent, plan })
              })
              if (!response.ok) {
                throw new Error(`restate ingress returned ${response.status}`)
              }
              return response
            },
            catch: (cause) => new PlanExecutionError(`cannot submit plan to Restate: ${String(cause)}`)
          })

          return { executionId: key, mode: "restate" as const }
        })
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
