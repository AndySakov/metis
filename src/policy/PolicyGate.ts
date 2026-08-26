/**
 * Policy in the execution path.
 *
 * `PolicyEngine` decides; this writes the decision to the event log and returns it. The separation
 * matters: the engine is pure and re-runnable, and everything that makes a decision *durable and
 * auditable* lives here.
 *
 * **Every evaluation is recorded, including the ones no rule matched.** That is not incidental
 * bookkeeping — it is the entire input to the coverage report (ADR-014). If unmatched evaluations
 * went unwritten, the unmatched fraction would read as zero and the system would appear fully
 * governed precisely when it is least governed.
 */

import { Context, Effect, Layer } from "effect"

import type { Actor, EpochSeconds } from "../domain/Common.js"
import type { CorrelationId, EventId, EventType } from "../domain/Event.js"
import { Event } from "../domain/Event.js"
import { uuidv7 } from "../domain/Ids.js"
import type { PolicyDecision, PolicyRequest } from "../domain/Policy.js"
import { EventLogStore } from "../mneme/EventLogStore.js"
import { PolicyEngine } from "./PolicyEngine.js"

export const POLICY_EVALUATED = "POLICY_EVALUATED" as EventType

export class PolicyGate extends Context.Tag("policy/PolicyGate")<PolicyGate, {
  /**
   * Evaluate and record. Returns the decision; the caller decides what to do about a `deny` or a
   * `require_approval`, because the right response differs by evaluation point.
   */
  readonly check: (
    request: PolicyRequest,
    correlationId?: CorrelationId
  ) => Effect.Effect<PolicyDecision>
}>() {}

export const make = Effect.gen(function*() {
  const engine = yield* PolicyEngine
  const log = yield* EventLogStore

  return PolicyGate.of({
    check: (request, correlationId) =>
      Effect.gen(function*() {
        const decision = yield* engine.evaluate(request)
        const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

        const event = new Event({
          id: uuidv7(millis) as EventId,
          ts: Math.floor(millis / 1000) as EpochSeconds,
          type: POLICY_EVALUATED,
          // The evaluation is METIS's own act, whoever the action was on behalf of. The requesting
          // principal is in the payload.
          actor: "metis" as Actor,
          payload: {
            at: decision.at,
            effect: decision.effect,
            basis: decision.basis,
            policyVersion: decision.policyVersion,
            consideredRuleIds: decision.consideredRuleIds,
            requestedBy: request.actor,
            autonomy: request.autonomy,
            capability: request.capability ?? null
          },
          ...(correlationId !== undefined ? { correlationId } : {})
        })

        // A failure to record must not be swallowed into a silent allow. If the audit write fails
        // the decision is not trustworthy, so the error is surfaced as a defect rather than being
        // absorbed — an unlogged policy evaluation is exactly the state ADR-014 is written against.
        yield* Effect.orDie(log.append(event))

        return decision
      })
  })
})

export const layer = Layer.effect(PolicyGate, make)
