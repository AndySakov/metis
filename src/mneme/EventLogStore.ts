import type { Effect } from "effect"
import { Context, Schema } from "effect"

import { Actor, EpochSeconds } from "../domain/Common.js"
import type { Event } from "../domain/Event.js"
import { EventId, EventType, ProjectId } from "../domain/Event.js"

export { Event, EventId, EventType, ProjectId } from "../domain/Event.js"

/** Filter for reading back the log. All fields optional; omitting everything reads the whole log. */
export class EventQuery extends Schema.Class<EventQuery>("EventQuery")({
  fromTs: Schema.optional(EpochSeconds),
  toTs: Schema.optional(EpochSeconds),
  types: Schema.optional(Schema.Array(EventType)),
  actor: Schema.optional(Actor),
  project: Schema.optional(ProjectId)
}) {}

export class EventLogAppendError extends Schema.TaggedError<EventLogAppendError>()("EventLogAppendError", {
  id: EventId,
  message: Schema.String
}) {}

export class EventLogReadError extends Schema.TaggedError<EventLogReadError>()("EventLogReadError", {
  query: EventQuery,
  message: Schema.String
}) {}

/**
 * The append-only timeline.
 *
 * `append` is idempotent by event id (ADR-007): appending the same id twice is one event, and the
 * second call returns the record that is already there rather than failing. Ordering is by `ts`,
 * with the identifier breaking ties — UUIDv7 sorts by creation time, which is the reason ADR-005
 * requires it.
 */
export class EventLogStore extends Context.Tag("mneme/EventLogStore")<EventLogStore, {
  append: (event: Event) => Effect.Effect<Event, EventLogAppendError>
  read: (query: EventQuery) => Effect.Effect<Array<Event>, EventLogReadError>
}>() {}
