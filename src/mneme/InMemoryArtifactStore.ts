/**
 * In-memory `ArtifactStore`.
 *
 * Holds payloads in a map, but enforces the same invariant the durable adapter must: the checksum
 * recorded is the checksum of the bytes stored, verified on the way in and again on the way out.
 */

import { createHash } from "node:crypto"

import { Effect, Layer, Ref } from "effect"

import type { Artifact, ArtifactId } from "../domain/Artifact.js"
import { ArtifactDeleteError, ArtifactRetrieveError, ArtifactStore, ArtifactStoreError } from "./ArtifactStore.js"

export const checksumOf = (payload: Uint8Array): string =>
  `sha256:${createHash("sha256").update(payload).digest("hex")}`

interface Stored {
  readonly metadata: Artifact
  readonly payload: Uint8Array
}

export const make = Effect.gen(function*() {
  const artifacts = yield* Ref.make(new Map<ArtifactId, Stored>())

  return ArtifactStore.of({
    /**
     * Rejects a checksum that does not describe the payload.
     *
     * ADR-001 requires every artifact to carry a checksum. A checksum nobody verifies is
     * decoration — it would still be present, still look right in the metadata, and still fail to
     * detect the corruption it exists to detect. So the check happens here, at the only point
     * where both the claim and the bytes are in hand.
     */
    put: (artifact, payload) =>
      Effect.gen(function*() {
        const actual = checksumOf(payload)
        if (actual !== artifact.checksum) {
          return yield* new ArtifactStoreError({
            id: artifact.id,
            message: `checksum mismatch: metadata claims ${artifact.checksum}, payload hashes to ${actual}`
          })
        }
        yield* Ref.update(artifacts, (current) => new Map(current).set(artifact.id, { metadata: artifact, payload }))
        return artifact
      }),

    get: (id) =>
      Effect.gen(function*() {
        const stored = (yield* Ref.get(artifacts)).get(id)
        if (stored === undefined) {
          return yield* new ArtifactRetrieveError({ id, message: "no such artifact" })
        }
        // Verified on read as well: storage can rot, and returning corrupt bytes under a checksum
        // that says otherwise is worse than returning an error.
        const actual = checksumOf(stored.payload)
        if (actual !== stored.metadata.checksum) {
          return yield* new ArtifactRetrieveError({
            id,
            message: `stored payload no longer matches its checksum (${stored.metadata.checksum} vs ${actual})`
          })
        }
        return { metadata: stored.metadata, payload: stored.payload }
      }),

    /** Metadata without transferring the payload — the reason ADR-007 separates this from `get`. */
    head: (id) =>
      Effect.gen(function*() {
        const stored = (yield* Ref.get(artifacts)).get(id)
        if (stored === undefined) {
          return yield* new ArtifactRetrieveError({ id, message: "no such artifact" })
        }
        return stored.metadata
      }),

    delete: (id) =>
      Effect.gen(function*() {
        const current = yield* Ref.get(artifacts)
        if (!current.has(id)) {
          return yield* new ArtifactDeleteError({ id, message: "no such artifact" })
        }
        const next = new Map(current)
        next.delete(id)
        yield* Ref.set(artifacts, next)
      })
  })
})

export const layer = Layer.effect(ArtifactStore, make)
