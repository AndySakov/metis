import { Schema } from "effect"

import { Actor, EpochSeconds, Uuid7 } from "./Common.js"

export const EventId = Uuid7.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

export const ProjectId = Uuid7.pipe(Schema.brand("ProjectId"))
export type ProjectId = typeof ProjectId.Type

/**
 * Ties every event produced by one request or run together. ADR-009 requires errors to carry the
 * same correlationId as the work that failed.
 */
export const CorrelationId = Uuid7.pipe(Schema.brand("CorrelationId"))
export type CorrelationId = typeof CorrelationId.Type

/**
 * SCREAMING_SNAKE. Left open rather than enumerated because new event types arrive with every
 * subsystem, but the shape is pinned so the log stays greppable.
 */
export const EventType = Schema.String.pipe(
  Schema.pattern(/^[A-Z][A-Z0-9_]*$/),
  Schema.annotations({ examples: ["PLAN_CREATED", "POLICY_EVALUATED", "ERROR"] }),
  Schema.brand("EventType"),
  Schema.annotations({ identifier: "EventType" })
)
export type EventType = typeof EventType.Type

/**
 * One entry in the METIS event log — the tamper-evident semantic record the safety story rests on.
 *
 * This is not Restate's execution journal and must never be merged with it (ADR-016): that journal
 * is disposable execution mechanics, this is the audit trail.
 */
export class Event extends Schema.Class<Event>("Event")({
  /** Also the idempotency key — appending the same id twice is one event (ADR-007). */
  id: EventId,
  ts: EpochSeconds,
  type: EventType,
  actor: Actor,
  project: Schema.optional(ProjectId),
  correlationId: Schema.optional(CorrelationId),
  payload: Schema.Unknown
}) {}
