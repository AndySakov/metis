/**
 * PostgreSQL-backed `EventLogStore`.
 *
 * Access goes through `@effect/sql` (ADR-018): SQL stays SQL, and the wrapper provides resource
 * management, typed errors and schema-validated rows rather than an abstraction over the query
 * language. Rows are decoded with the same Effect Schema the API uses, so a row that would not
 * survive the process boundary does not silently become an `Event` here.
 */

// Subpath import: the `@effect/sql` barrel also loads SqlPersistedQueue, which reaches for an
// `@effect/experimental` subpath the installed version does not export. Only SqlClient is needed.
import * as SqlClient from "@effect/sql/SqlClient"
import { Effect, Layer, Schema } from "effect"

import { EpochSecondsColumn } from "../db/Columns.js"
import { Actor } from "../domain/Common.js"
import { CorrelationId, Event, EventId, EventType, ProjectId } from "../domain/Event.js"
import { EventLogAppendError, EventLogReadError, EventLogStore } from "./EventLogStore.js"

/** The row shape, mapping snake_case columns onto the domain type. */
const EventRow = Schema.Struct({
  id: EventId,
  ts: EpochSecondsColumn,
  type: EventType,
  actor: Actor,
  project_id: Schema.NullOr(ProjectId),
  correlation_id: Schema.NullOr(CorrelationId),
  payload: Schema.Unknown
})

const toEvent = (row: typeof EventRow.Type): Event =>
  new Event({
    id: row.id,
    ts: row.ts,
    type: row.type,
    actor: row.actor,
    payload: row.payload,
    ...(row.project_id !== null ? { project: row.project_id } : {}),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {})
  })

const decodeRows = Schema.decodeUnknown(Schema.Array(EventRow))

export const make = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  return EventLogStore.of({
    /**
     * Idempotent by id, enforced by the primary key rather than by a read-then-write.
     *
     * `ON CONFLICT DO NOTHING` followed by a read of the stored row gives first-write-wins in a
     * single statement pair with no race: two concurrent appends of the same id cannot both
     * insert, and whichever loses reads back the winner. Checking for existence first and then
     * inserting would be a classic time-of-check-to-time-of-use bug on an audit log.
     */
    append: (event) =>
      Effect.gen(function*() {
        yield* sql`
          INSERT INTO event (id, ts, type, actor, project_id, correlation_id, payload)
          VALUES (
            ${event.id}, ${event.ts}, ${event.type}, ${event.actor},
            ${event.project ?? null}, ${event.correlationId ?? null},
            ${JSON.stringify(event.payload ?? null)}::jsonb
          )
          ON CONFLICT (id) DO NOTHING
        `

        const rows = yield* sql`
          SELECT id, ts, type, actor, project_id, correlation_id, payload
          FROM event WHERE id = ${event.id}
        `
        const decoded = yield* decodeRows(rows)
        const stored = decoded[0]
        if (stored === undefined) {
          return yield* new EventLogAppendError({ id: event.id, message: "insert reported success but row is absent" })
        }
        return toEvent(stored)
      }).pipe(
        Effect.catchAll((cause) =>
          cause instanceof EventLogAppendError
            ? Effect.fail(cause)
            : new EventLogAppendError({ id: event.id, message: String(cause) })
        )
      ),

    read: (query) =>
      Effect.gen(function*() {
        // Ordered by (ts, id) to match the index and the in-memory adapter. The identifier breaks
        // ties within a second because UUIDv7 sorts by creation time (ADR-005).
        const rows = yield* sql`
          SELECT id, ts, type, actor, project_id, correlation_id, payload
          FROM event
          WHERE ${
          sql.and([
            query.fromTs !== undefined ? sql`ts >= ${query.fromTs}` : sql`TRUE`,
            query.toTs !== undefined ? sql`ts <= ${query.toTs}` : sql`TRUE`,
            query.actor !== undefined ? sql`actor = ${query.actor}` : sql`TRUE`,
            query.project !== undefined ? sql`project_id = ${query.project}` : sql`TRUE`,
            query.types !== undefined && query.types.length > 0 ? sql.in("type", query.types) : sql`TRUE`
          ])
        }
          ORDER BY ts ASC, id ASC
        `
        const decoded = yield* decodeRows(rows)
        return decoded.map(toEvent)
      }).pipe(
        Effect.catchAll((cause) => new EventLogReadError({ query, message: String(cause) }))
      )
  })
})

export const layer = Layer.effect(EventLogStore, make)
