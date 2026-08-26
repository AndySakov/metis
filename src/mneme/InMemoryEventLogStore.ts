/**
 * In-memory `EventLogStore`.
 *
 * Not a toy: it is the reference against which the Postgres adapter is compared. Both run the same
 * conformance vectors, so "the database does something the interface does not promise" shows up as
 * a failing test rather than as behaviour someone depends on by accident.
 */

import { Effect, Layer, Ref } from "effect"

import type { Event } from "../domain/Event.js"
import { EventLogStore } from "./EventLogStore.js"
import type { EventQuery } from "./EventLogStore.js"

/**
 * Timeline order: by `ts`, then by identifier.
 *
 * The tie-break is not arbitrary. UUIDv7 embeds a millisecond timestamp in its leading bits and
 * sorts lexicographically, so ordering by id within a second orders by actual creation time. This
 * is the property ADR-005 exists to provide, and the reason a v4 identifier would quietly break
 * the log's ordering rather than failing loudly.
 */
const byTimeline = (a: Event, b: Event): number => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts - b.ts)

const matches = (event: Event, query: EventQuery): boolean => {
  if (query.fromTs !== undefined && event.ts < query.fromTs) return false
  if (query.toTs !== undefined && event.ts > query.toTs) return false
  if (query.actor !== undefined && event.actor !== query.actor) return false
  if (query.project !== undefined && event.project !== query.project) return false
  if (query.types !== undefined && !query.types.includes(event.type)) return false
  return true
}

export const make = Effect.gen(function*() {
  const events = yield* Ref.make(new Map<string, Event>())

  return EventLogStore.of({
    /**
     * Idempotent by id (ADR-007). A repeated append is one event and **the first write wins** —
     * the stored record is returned unchanged rather than being overwritten.
     *
     * This matters beyond tidiness: durable execution replays (ADR-016), so the same append can
     * legitimately arrive twice. If the second write won, a replay would silently rewrite the
     * timestamp on an audit record, which is precisely the tamper the event log exists to prevent.
     */
    append: (event) =>
      Ref.modify(events, (current) => {
        const existing = current.get(event.id)
        if (existing !== undefined) return [existing, current]
        const next = new Map(current)
        next.set(event.id, event)
        return [event, next]
      }),

    read: (query) =>
      Ref.get(events).pipe(
        Effect.map((current) => Array.from(current.values()).filter((event) => matches(event, query)).sort(byTimeline))
      )
  })
})

export const layer = Layer.effect(EventLogStore, make)
