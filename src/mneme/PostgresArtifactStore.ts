/**
 * PostgreSQL-backed `ArtifactStore`.
 *
 * Metadata lives in `artifact`, provenance links in `artifact_provenance`, and bytes in
 * `artifact_payload`. Reading metadata never touches the payload table, which is the whole reason
 * ADR-007 gives `head` and `get` separate operations.
 */

// Subpath import: the `@effect/sql` barrel also loads SqlPersistedQueue, which reaches for an
// `@effect/experimental` subpath the installed version does not export. Only SqlClient is needed.
import * as SqlClient from "@effect/sql/SqlClient"
import { Effect, Layer, Schema } from "effect"

import { EpochSecondsColumn } from "../db/Columns.js"
import type { ArtifactId } from "../domain/Artifact.js"
import { Artifact, ArtifactUri, Checksum, ProvenanceLink } from "../domain/Artifact.js"
import { Actor, ArtifactKind, LongText, ShortText } from "../domain/Common.js"
import { ArtifactDeleteError, ArtifactRetrieveError, ArtifactStore, ArtifactStoreError } from "./ArtifactStore.js"
import { checksumOf } from "./InMemoryArtifactStore.js"

const ArtifactRow = Schema.Struct({
  id: Schema.String,
  kind: ArtifactKind,
  title: ShortText,
  description: Schema.NullOr(LongText),
  uri: ArtifactUri,
  checksum: Checksum,
  created_at: EpochSecondsColumn,
  created_by: Actor,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})

const ProvenanceRow = Schema.Struct({ rel: Schema.String, ref: Schema.String })

const decodeArtifactRows = Schema.decodeUnknown(Schema.Array(ArtifactRow))
const decodeProvenanceRows = Schema.decodeUnknown(Schema.Array(ProvenanceRow))

export const make = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  /** Metadata plus provenance, without going near the payload table. */
  const readMetadata = (id: ArtifactId) =>
    Effect.gen(function*() {
      const rows = yield* sql`
        SELECT id, kind, title, description, uri, checksum, created_at, created_by, metadata
        FROM artifact WHERE id = ${id}
      `
      const decoded = yield* decodeArtifactRows(rows)
      const row = decoded[0]
      if (row === undefined) return undefined

      const provenanceRows = yield* sql`
        SELECT rel, ref FROM artifact_provenance WHERE artifact_id = ${id} ORDER BY rel, ref
      `
      const provenance = yield* decodeProvenanceRows(provenanceRows)

      return new Artifact({
        id,
        kind: row.kind,
        title: row.title,
        uri: row.uri,
        checksum: row.checksum,
        createdAt: row.created_at,
        createdBy: row.created_by,
        metadata: row.metadata,
        provenance: provenance.map((p) => new ProvenanceLink({ rel: p.rel, ref: p.ref })),
        ...(row.description !== null ? { description: row.description } : {})
      })
    })

  return ArtifactStore.of({
    put: (artifact, payload) =>
      Effect.gen(function*() {
        // Same invariant as the in-memory adapter: the checksum must describe the bytes. Checked
        // before anything is written, so a mismatched artifact leaves no partial row behind.
        const actual = checksumOf(payload)
        if (actual !== artifact.checksum) {
          return yield* new ArtifactStoreError({
            id: artifact.id,
            message: `checksum mismatch: metadata claims ${artifact.checksum}, payload hashes to ${actual}`
          })
        }

        yield* sql.withTransaction(
          Effect.gen(function*() {
            yield* sql`
              INSERT INTO artifact (id, kind, title, description, uri, checksum, created_by, metadata, created_at)
              VALUES (
                ${artifact.id}, ${artifact.kind}::artifact_kind, ${artifact.title},
                ${artifact.description ?? null}, ${artifact.uri}, ${artifact.checksum},
                ${artifact.createdBy}, ${JSON.stringify(artifact.metadata)}::jsonb, ${artifact.createdAt}
              )
              ON CONFLICT (id) DO NOTHING
            `

            for (const link of artifact.provenance) {
              yield* sql`
                INSERT INTO artifact_provenance (artifact_id, rel, ref)
                VALUES (${artifact.id}, ${link.rel}, ${link.ref})
                ON CONFLICT DO NOTHING
              `
            }

            yield* sql`
              INSERT INTO artifact_payload (artifact_id, bytes, byte_length)
              VALUES (${artifact.id}, ${Buffer.from(payload)}, ${payload.byteLength})
              ON CONFLICT (artifact_id) DO NOTHING
            `
          })
        )

        return artifact
      }).pipe(
        Effect.catchAll((cause) =>
          cause instanceof ArtifactStoreError
            ? Effect.fail(cause)
            : new ArtifactStoreError({ id: artifact.id, message: String(cause) })
        )
      ),

    get: (id) =>
      Effect.gen(function*() {
        const metadata = yield* readMetadata(id)
        if (metadata === undefined) {
          return yield* new ArtifactRetrieveError({ id, message: "no such artifact" })
        }

        const rows = yield* sql`SELECT bytes FROM artifact_payload WHERE artifact_id = ${id}`
        const row = rows[0] as { bytes: Buffer } | undefined
        if (row === undefined) {
          return yield* new ArtifactRetrieveError({
            id,
            message: "artifact metadata exists but its payload is not stored here"
          })
        }

        const payload = new Uint8Array(row.bytes)
        const actual = checksumOf(payload)
        if (actual !== metadata.checksum) {
          return yield* new ArtifactRetrieveError({
            id,
            message: `stored payload no longer matches its checksum (${metadata.checksum} vs ${actual})`
          })
        }

        return { metadata, payload }
      }).pipe(
        Effect.catchAll((cause) =>
          cause instanceof ArtifactRetrieveError
            ? Effect.fail(cause)
            : new ArtifactRetrieveError({ id, message: String(cause) })
        )
      ),

    head: (id) =>
      Effect.gen(function*() {
        const metadata = yield* readMetadata(id)
        if (metadata === undefined) {
          return yield* new ArtifactRetrieveError({ id, message: "no such artifact" })
        }
        return metadata
      }).pipe(
        Effect.catchAll((cause) =>
          cause instanceof ArtifactRetrieveError
            ? Effect.fail(cause)
            : new ArtifactRetrieveError({ id, message: String(cause) })
        )
      ),

    delete: (id) =>
      Effect.gen(function*() {
        // Provenance and payload cascade from the foreign keys.
        const rows = yield* sql`DELETE FROM artifact WHERE id = ${id} RETURNING id`
        if (rows.length === 0) {
          return yield* new ArtifactDeleteError({ id, message: "no such artifact" })
        }
      }).pipe(
        Effect.catchAll((cause) =>
          cause instanceof ArtifactDeleteError
            ? Effect.fail(cause)
            : new ArtifactDeleteError({ id, message: String(cause) })
        )
      )
  })
})

export const layer = Layer.effect(ArtifactStore, make)
