/**
 * Sampled verification (ADR-014 §4).
 *
 * A random sample of executed actions is checked against expectation, **independent of whether any
 * rule flagged them**. This exists because rules only catch what they were written for. Random
 * sampling is the only mechanism in the system that can find the failure nobody anticipated, and it
 * is how every serious auditing discipline outside software has handled volume for a century.
 *
 * The limitation, stated plainly because ADR-014 requires it to be: sampling bounds how *often*
 * things go wrong. It will not reliably find a single rare catastrophic action. Do not conflate the
 * two — not in this code, and not in any claim made about the system.
 *
 * What "verified against expectation" means concretely: a tool's output is checked against the
 * output schema its capability declares. A tool that returns something its own contract does not
 * describe is a real finding, and one no policy rule would have caught, because policy governs
 * whether an action is permitted rather than whether its result is well-formed.
 */

import { Context, Effect, Layer } from "effect"

import type { Actor, CapabilityId, EpochSeconds } from "../domain/Common.js"
import type { CorrelationId, EventId, EventType } from "../domain/Event.js"
import { Event } from "../domain/Event.js"
import { uuidv7 } from "../domain/Ids.js"
import type { ToolSpec } from "../domain/ToolSpec.js"
import { EventLogStore } from "../mneme/EventLogStore.js"

export const VERIFICATION_SAMPLED = "VERIFICATION_SAMPLED" as EventType

export interface VerificationResult {
  readonly sampled: boolean
  readonly clean: boolean
  readonly findings: ReadonlyArray<string>
}

/**
 * Decides whether a given action is sampled.
 *
 * Injected rather than calling `Math.random()` inline so the rate is policy-configured (ADR-014)
 * and so tests can pin the decision instead of hoping.
 */
export class Sampler extends Context.Tag("policy/Sampler")<Sampler, {
  readonly shouldSample: Effect.Effect<boolean>
}>() {}

/** Samples a fixed fraction of actions. `rate` is clamped to [0,1]. */
export const randomSampler = (rate: number) =>
  Layer.succeed(Sampler, {
    shouldSample: Effect.sync(() => Math.random() < Math.min(1, Math.max(0, rate)))
  })

/** Samples everything, or nothing. For tests and for a deliberate full audit. */
export const alwaysSample = Layer.succeed(Sampler, { shouldSample: Effect.succeed(true) })
export const neverSample = Layer.succeed(Sampler, { shouldSample: Effect.succeed(false) })

/**
 * Checks an output against the shape its capability declares.
 *
 * Only the structural claims the descriptor actually makes are enforced — `required` keys and
 * declared property types. This is deliberately shallow: a full JSON Schema evaluator here would
 * be a second validation implementation competing with Effect Schema, and the point is to catch a
 * tool returning something obviously other than what it promised.
 */
export const findingsFor = (spec: ToolSpec, output: unknown): Array<string> => {
  const findings: Array<string> = []
  const schema = spec.outputSchema

  if (schema === undefined) {
    // Not a violation — but worth recording, since an undeclared output cannot be verified at all.
    return ["capability declares no output schema, so the result cannot be verified"]
  }

  if (output === null || typeof output !== "object") {
    findings.push(`expected an object output, got ${output === null ? "null" : typeof output}`)
    return findings
  }

  const record = output as Record<string, unknown>
  const required = Array.isArray(schema.required) ? schema.required as Array<string> : []

  for (const key of required) {
    if (!(key in record)) findings.push(`missing required output field "${key}"`)
  }

  const properties = (schema.properties ?? {}) as Record<string, { type?: unknown }>
  for (const [key, declared] of Object.entries(properties)) {
    if (!(key in record)) continue
    const expected = declared.type
    if (typeof expected !== "string") continue

    const actual = Array.isArray(record[key]) ? "array" : record[key] === null ? "null" : typeof record[key]
    const matches = expected === actual ||
      (expected === "integer" && actual === "number") ||
      (expected === "object" && actual === "object")
    if (!matches) findings.push(`output field "${key}" should be ${expected}, got ${actual}`)
  }

  return findings
}

/**
 * Verify one action if it is sampled, recording the outcome either way it lands.
 *
 * The event is written whether the sample is clean or not: a verification that only logged failures
 * would make the clean rate uncomputable, and the clean rate is what feeds the compliance ledger.
 */
export const verify = (
  spec: ToolSpec,
  capability: CapabilityId,
  output: unknown,
  correlationId?: CorrelationId
): Effect.Effect<VerificationResult, never, Sampler | EventLogStore> =>
  Effect.gen(function*() {
    const sampler = yield* Sampler
    const sampled = yield* sampler.shouldSample
    if (!sampled) return { sampled: false, clean: true, findings: [] }

    const findings = findingsFor(spec, output)
    const clean = findings.length === 0

    const log = yield* EventLogStore
    const millis = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

    yield* Effect.orDie(
      log.append(
        new Event({
          id: uuidv7(millis) as EventId,
          ts: Math.floor(millis / 1000) as EpochSeconds,
          type: VERIFICATION_SAMPLED,
          actor: "metis" as Actor,
          payload: { capability, tool: spec.name, clean, findings },
          ...(correlationId !== undefined ? { correlationId } : {})
        })
      )
    )

    return { sampled: true, clean, findings }
  })
