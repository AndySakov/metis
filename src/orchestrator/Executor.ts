/**
 * Plan execution.
 *
 * ADR-016 draws the line: "Restate owns retries, backoff, checkpointing, suspension and
 * resumption. METIS owns planning, policy, tool dispatch and memory." This is the METIS side. It
 * walks a plan's steps, evaluates policy at the three points, dispatches tools and writes
 * artifacts.
 *
 * It deliberately contains **no durability machinery** — no retry loop, no backoff, no checkpoint
 * writing, no suspension primitive. Those are Restate's, and hand-rolling them is the specific
 * failure ADR-016 exists to prevent, because they fail silently and at the worst moment.
 *
 * Approval is handled by *stopping*, not by suspending: an un-approved gated step ends the run with
 * `awaiting_approval` and the caller re-invokes with the approval granted. That is why policy is
 * re-evaluated from scratch on every invocation and no decision is ever carried across one — a
 * cached allow from before an approval is invalid, since both the policy and the trust ledger may
 * have moved in between (ADR-016).
 */

import { Effect } from "effect"

import type { Artifact, ArtifactId, ArtifactUri, Checksum } from "../domain/Artifact.js"
import { ProvenanceLink } from "../domain/Artifact.js"
import type { Actor, EpochSeconds } from "../domain/Common.js"
import type { CorrelationId, EventId, EventType } from "../domain/Event.js"
import { Event } from "../domain/Event.js"
import { uuidv7 } from "../domain/Ids.js"
import type { Intent } from "../domain/Intent.js"
import type { Plan, PlanStep, PlanStepId } from "../domain/Plan.js"
import { PolicyRequest } from "../domain/Policy.js"
import { ArtifactStore } from "../mneme/ArtifactStore.js"
import { EventLogStore } from "../mneme/EventLogStore.js"
import { checksumOf } from "../mneme/InMemoryArtifactStore.js"
import { PolicyGate } from "../policy/PolicyGate.js"
import { TrustLedger } from "../policy/TrustLedger.js"
import { skillOf } from "../policy/TrustUpdater.js"
import type { Sampler } from "../policy/Verification.js"
import { verify } from "../policy/Verification.js"
import { ToolRegistry } from "../tools/ToolRegistry.js"
import { ToolRunner } from "../tools/ToolRunner.js"

export type StepStatus =
  | "completed"
  | "awaiting_approval"
  | "denied"
  | "failed"
  | "skipped"

export interface StepResult {
  readonly stepId: PlanStepId
  readonly status: StepStatus
  readonly detail?: string
  readonly artifactId?: ArtifactId
}

export type ExecutionStatus = "completed" | "awaiting_approval" | "denied" | "failed"

export interface ExecutionReport {
  readonly planId: string
  readonly status: ExecutionStatus
  readonly steps: ReadonlyArray<StepResult>
  readonly correlationId: CorrelationId
}

export interface ExecuteOptions {
  /** Steps the user has approved. A gated step not named here stops the run. */
  readonly approvedSteps?: ReadonlyArray<PlanStepId>
}

const METIS = "metis" as Actor

/** Which output field of a capability is the artifact body, if any. */
const artifactBody = (output: unknown): string | undefined => {
  if (output === null || typeof output !== "object") return undefined
  const record = output as Record<string, unknown>
  for (const key of ["markdown", "text", "content"]) {
    if (typeof record[key] === "string") return record[key] as string
  }
  return undefined
}

/**
 * How many identical dispatches before the breaker trips (OpenCode uses the same figure).
 *
 * Two identical calls are ordinary — a plan may legitimately ask for the same thing twice. Three
 * in one walk of a plan is a loop, and a loop that nobody stops is an agent burning budget or
 * repeating a side effect until something else breaks.
 */
const DOOM_LOOP_THRESHOLD = 3

/**
 * Identity of a call for repeat detection: capability plus input, with object keys ordered so two
 * structurally equal inputs produce the same key regardless of how they were built.
 *
 * Deliberately *not* keyed on the step id. A loop produces a fresh step id every time round, so
 * keying on identity would make the breaker unable to see the thing it exists to catch.
 */
const callKey = (capability: string, input: unknown): string => {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, stable((value as Record<string, unknown>)[key])])
      )
    }
    return value
  }
  return `${capability}\u0000${JSON.stringify(stable(input))}`
}

export const execute = (
  intent: Intent,
  plan: Plan,
  options: ExecuteOptions = {}
): Effect.Effect<
  ExecutionReport,
  never,
  PolicyGate | EventLogStore | ArtifactStore | ToolRegistry | ToolRunner | TrustLedger | Sampler
> =>
  Effect.gen(function*() {
    const gate = yield* PolicyGate
    const log = yield* EventLogStore
    const artifacts = yield* ArtifactStore
    const registry = yield* ToolRegistry
    const runner = yield* ToolRunner
    const trust = yield* TrustLedger

    const correlationId = uuidv7() as CorrelationId
    const approved = new Set(options.approvedSteps ?? [])

    const now = Effect.map(
      Effect.clockWith((clock) => clock.currentTimeMillis),
      (millis) => Math.floor(millis / 1000) as EpochSeconds
    )

    const emit = (type: string, payload: unknown) =>
      Effect.gen(function*() {
        const ts = yield* now
        yield* Effect.orDie(
          log.append(
            new Event({
              id: uuidv7() as EventId,
              ts,
              type: type as EventType,
              actor: METIS,
              correlationId,
              payload
            })
          )
        )
      })

    const results: Array<StepResult> = []

    // ---- Point 1: plan validation -------------------------------------------------------------
    const planDecision = yield* gate.check(
      new PolicyRequest({
        at: "plan_validation",
        actor: intent.actor,
        autonomy: intent.autonomy,
        tags: intent.inputs.flatMap((input) => input.tags)
      }),
      correlationId
    )

    if (planDecision.effect === "deny") {
      yield* emit("PLAN_DENIED", { planId: plan.id, basis: planDecision.basis })
      return {
        planId: plan.id,
        status: "denied" as const,
        steps: plan.steps.map((step) => ({ stepId: step.id, status: "skipped" as const })),
        correlationId
      }
    }

    yield* emit("PLAN_STARTED", { planId: plan.id, intentId: plan.intentId, steps: plan.steps.length })

    let halted = false
    let finalStatus: ExecutionStatus = "completed"

    // Scoped to this invocation, like every other decision in here: on resume the executor
    // re-derives rather than restores (ADR-016), and the repeat count is no exception.
    const dispatches = new Map<string, number>()

    for (const step of plan.steps) {
      if (halted) {
        results.push({ stepId: step.id, status: "skipped" })
        continue
      }

      const outcome = yield* runStep(step)
      results.push(outcome)

      if (outcome.status !== "completed") {
        halted = true
        finalStatus = outcome.status === "awaiting_approval"
          ? "awaiting_approval"
          : outcome.status === "denied"
          ? "denied"
          : "failed"
      }
    }

    yield* emit("PLAN_FINISHED", { planId: plan.id, status: finalStatus })

    return { planId: plan.id, status: finalStatus, steps: results, correlationId }

    // -------------------------------------------------------------------------------------------

    function runStep(step: PlanStep): Effect.Effect<StepResult, never, Sampler | EventLogStore> {
      return Effect.gen(function*() {
        // A step with nothing to execute is a note to a human; it completes without dispatch.
        if (step.toolCall === undefined) {
          yield* emit("STEP_COMPLETED", { stepId: step.id, kind: step.kind })
          return { stepId: step.id, status: "completed" as const }
        }

        const specs = yield* Effect.either(registry.select(step.toolCall.capability))
        if (specs._tag === "Left") {
          yield* emit("STEP_FAILED", { stepId: step.id, reason: specs.left.message })
          return { stepId: step.id, status: "failed" as const, detail: specs.left.message }
        }
        const spec = specs.right

        // ---- Point 2: tool dispatch -------------------------------------------------------
        // Evaluated fresh every invocation, never restored from a previous run (ADR-016).
        const decision = yield* gate.check(
          new PolicyRequest({
            at: "tool_dispatch",
            actor: intent.actor,
            autonomy: intent.autonomy,
            capability: step.toolCall.capability,
            scopes: spec.authScopes,
            tags: intent.inputs.flatMap((input) => input.tags),
            idempotent: spec.idempotent
          }),
          correlationId
        )

        if (decision.effect === "deny") {
          yield* emit("STEP_DENIED", { stepId: step.id, basis: decision.basis })
          return { stepId: step.id, status: "denied" as const, detail: "policy denied dispatch" }
        }

        // ---- Gear enforcement -------------------------------------------------------------
        // A skill may only run unattended at a gear its trust actually supports (ADR-002,
        // ADR-014). The intent asks for a gear; the ledger decides whether this skill has earned
        // it. An untrusted skill is not denied outright — it falls back to human oversight, which
        // is the useful failure mode: the work can still happen, just not unwatched.
        const verdict = yield* trust.permits(skillOf(step.toolCall.capability), intent.autonomy)
        if (!verdict.permitted) {
          yield* emit("TRUST_GATE", {
            stepId: step.id,
            capability: step.toolCall.capability,
            requestedGear: intent.autonomy,
            blockedBy: verdict.blockedBy,
            required: verdict.required,
            actual: verdict.actual
          })
        }

        // ---- Circuit breaker ---------------------------------------------------------------
        // A repeated identical call escalates to a human rather than being denied: the useful
        // failure mode is "stop and ask", because a loop is usually a bug in what asked for the
        // work, not an attack. Denying would also make the step unrecoverable by approval.
        const key = callKey(step.toolCall.capability, step.toolCall.input)
        const repeats = (dispatches.get(key) ?? 0) + 1
        dispatches.set(key, repeats)
        const loopTripped = repeats >= DOOM_LOOP_THRESHOLD
        if (loopTripped) {
          yield* emit("DOOM_LOOP_DETECTED", {
            stepId: step.id,
            capability: step.toolCall.capability,
            repeats,
            threshold: DOOM_LOOP_THRESHOLD
          })
        }

        // The gate can require approval even when the plan did not — policy changes between
        // planning and execution, and the decision that counts is the one made now.
        const needsApproval = step.requiresApproval ||
          decision.effect === "require_approval" ||
          !verdict.permitted ||
          loopTripped
        if (needsApproval && !approved.has(step.id)) {
          yield* emit("APPROVAL_REQUESTED", {
            stepId: step.id,
            capability: step.toolCall.capability,
            basis: decision.basis
          })
          return { stepId: step.id, status: "awaiting_approval" as const }
        }
        if (needsApproval) {
          yield* emit("APPROVAL_GRANTED", { stepId: step.id })
        }

        yield* emit("TOOL_STARTED", {
          stepId: step.id,
          capability: step.toolCall.capability,
          tool: spec.name
        })

        const ran = yield* Effect.either(runner.run(spec, step.toolCall.input))
        if (ran._tag === "Left") {
          yield* emit("STEP_FAILED", { stepId: step.id, reason: ran.left.message })
          return { stepId: step.id, status: "failed" as const, detail: ran.left.message }
        }

        yield* emit("TOOL_COMPLETED", {
          stepId: step.id,
          capability: step.toolCall.capability,
          tool: spec.name,
          durationMs: ran.right.durationMs
        })

        // ---- Sampled verification (ADR-014 §4) ---------------------------------------------
        // Runs regardless of whether any rule flagged this action; that independence is the whole
        // point, since rules only catch what they were written for.
        const verification = yield* verify(spec, step.toolCall.capability, ran.right.output, correlationId)
        if (verification.sampled && !verification.clean) {
          yield* emit("VERIFICATION_FAILED", {
            stepId: step.id,
            capability: step.toolCall.capability,
            findings: verification.findings
          })
        }

        const body = artifactBody(ran.right.output)
        if (body === undefined) {
          return { stepId: step.id, status: "completed" as const }
        }

        // ---- Point 3: artifact write ------------------------------------------------------
        const writeDecision = yield* gate.check(
          new PolicyRequest({
            at: "artifact_write",
            actor: intent.actor,
            autonomy: intent.autonomy,
            capability: step.toolCall.capability,
            tags: intent.inputs.flatMap((input) => input.tags)
          }),
          correlationId
        )

        if (writeDecision.effect === "deny") {
          yield* emit("ARTIFACT_WRITE_DENIED", { stepId: step.id, basis: writeDecision.basis })
          return { stepId: step.id, status: "denied" as const, detail: "policy denied artifact write" }
        }
        if (writeDecision.effect === "require_approval" && !approved.has(step.id)) {
          yield* emit("APPROVAL_REQUESTED", { stepId: step.id, forWrite: true })
          return { stepId: step.id, status: "awaiting_approval" as const }
        }

        const payload = new TextEncoder().encode(body)
        const artifactId = uuidv7() as ArtifactId
        const ts = yield* now

        const stored = yield* Effect.either(
          artifacts.put(
            {
              id: artifactId,
              kind: "text",
              title: step.description.slice(0, 200),
              uri: `metis://artifact/${artifactId}` as ArtifactUri,
              checksum: checksumOf(payload) as Checksum,
              createdAt: ts,
              createdBy: METIS,
              metadata: {},
              // Provenance is written at the moment the artifact is created, when the plan and
              // step that produced it are still in hand (ADR-001).
              provenance: [
                new ProvenanceLink({ rel: "produced_by", ref: plan.id }),
                new ProvenanceLink({ rel: "derives_from", ref: intent.id })
              ]
            } as Artifact,
            payload
          )
        )

        if (stored._tag === "Left") {
          yield* emit("STEP_FAILED", { stepId: step.id, reason: stored.left.message })
          return { stepId: step.id, status: "failed" as const, detail: stored.left.message }
        }

        yield* emit("ARTIFACT_WRITTEN", {
          stepId: step.id,
          artifactId,
          checksum: stored.right.checksum
        })

        return { stepId: step.id, status: "completed" as const, artifactId }
      })
    }
  })
