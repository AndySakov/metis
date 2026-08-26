/**
 * Plan execution as a Restate workflow (ADR-016).
 *
 * The division of labour ADR-016 sets out: **Restate owns retries, backoff, checkpointing,
 * suspension and resumption. METIS owns planning, policy, tool dispatch and memory.** This file is
 * the seam. Each plan step becomes a durable step; everything inside one is the existing executor
 * logic, unchanged.
 *
 * Two properties this must preserve, both easy to lose while adding checkpoints:
 *
 * 1. **Policy is re-evaluated on resume, never restored from a checkpoint.** A workflow suspended
 *    for an approval may resume hours later under a policy that has since changed and a trust
 *    ledger that has since moved. A cached allow from before the suspension is invalid. So the
 *    policy evaluation deliberately happens *inside* the durable step rather than having its
 *    result memoised across one.
 * 2. **Restate's journal is not METIS's event log.** The journal is execution mechanics and may be
 *    discarded on migration; the event log is the tamper-evident audit record. They stay separate.
 *
 * Suspension here is real: `ctx.promise` parks the workflow until an approval is signalled from
 * outside, and the process may be killed and restarted in between.
 */

import * as restate from "@restatedev/restate-sdk"

import type { Intent } from "../domain/Intent.js"
import type { Plan, PlanStepId } from "../domain/Plan.js"
import type { ExecutionReport } from "./Executor.js"

/** Signalled from outside to release a step waiting on approval. */
export const APPROVAL_PROMISE = "approval"

export interface PlanRun {
  readonly intent: Intent
  readonly plan: Plan
}

/**
 * What the workflow needs from METIS.
 *
 * Injected rather than imported so the workflow can be exercised without standing up the whole
 * runtime, and so the durable layer has no opinion about how a step is executed.
 */
export interface PlanExecutionDeps {
  /**
   * Executes the plan and returns a report. Called *inside* a durable step, so policy is evaluated
   * fresh on every attempt — including after a resume.
   */
  readonly execute: (
    intent: Intent,
    plan: Plan,
    approvedSteps: ReadonlyArray<PlanStepId>
  ) => Promise<ExecutionReport>
}

export const planWorkflow = (deps: PlanExecutionDeps) =>
  restate.workflow({
    name: "plan",
    handlers: {
      run: async (ctx: restate.WorkflowContext, run: PlanRun): Promise<ExecutionReport> => {
        const approved: Array<PlanStepId> = []

        // Bounded rather than `while (true)`: a plan cannot need more approvals than it has steps,
        // and an unbounded loop here would turn a bug into an infinite durable workflow.
        for (let round = 0; round <= run.plan.steps.length; round++) {
          const snapshot = [...approved]

          // `ctx.run` is the durable step. A crash mid-execution replays this step rather than the
          // whole workflow, and the policy evaluation inside it runs again against current state.
          const report = await ctx.run(`execute-${round}`, () => deps.execute(run.intent, run.plan, snapshot))

          if (report.status !== "awaiting_approval") return report

          const waiting = report.steps.find((step) => step.status === "awaiting_approval")
          if (waiting === undefined) return report

          // Real suspension: the workflow parks here. The process can be killed and restarted, and
          // it resumes at this point when the approval arrives.
          const granted = await ctx.promise<boolean>(`${APPROVAL_PROMISE}-${waiting.stepId}`)
          if (!granted) return report

          approved.push(waiting.stepId)
        }

        // Ran out of rounds — more approval requests than steps means something is wrong with the
        // executor rather than with the plan, so surface it instead of looping.
        return deps.execute(run.intent, run.plan, approved)
      },

      /** Signalled from outside to approve (or refuse) a parked step. */
      approve: async (
        ctx: restate.WorkflowSharedContext,
        request: { stepId: PlanStepId; granted: boolean }
      ): Promise<void> => {
        await ctx.promise<boolean>(`${APPROVAL_PROMISE}-${request.stepId}`).resolve(request.granted)
      }
    }
  })

export type PlanWorkflow = ReturnType<typeof planWorkflow>
