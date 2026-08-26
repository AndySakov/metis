import type { Effect } from "effect"
import { Context, Schema } from "effect"

import type { Artifact } from "../domain/Artifact.js"
import { ArtifactId } from "../domain/Artifact.js"

export { Artifact, ArtifactId } from "../domain/Artifact.js"

export class ArtifactStoreError extends Schema.TaggedError<ArtifactStoreError>()("ArtifactStoreError", {
  id: ArtifactId,
  message: Schema.String
}) {}

export class ArtifactRetrieveError extends Schema.TaggedError<ArtifactRetrieveError>()("ArtifactRetrieveError", {
  id: ArtifactId,
  message: Schema.String
}) {}

export class ArtifactDeleteError extends Schema.TaggedError<ArtifactDeleteError>()("ArtifactDeleteError", {
  id: ArtifactId,
  message: Schema.String
}) {}

/**
 * Versioned, checksummed blobs.
 *
 * Payload and metadata are separate throughout, per ADR-007: `head` returns metadata without
 * moving bytes, which is what makes listing and referencing artifacts cheap. The store is
 * responsible for verifying that the bytes it returns hash to the checksum it recorded.
 */
export class ArtifactStore extends Context.Tag("mneme/ArtifactStore")<ArtifactStore, {
  put: (artifact: Artifact, payload: Uint8Array) => Effect.Effect<Artifact, ArtifactStoreError>
  get: (
    id: ArtifactId
  ) => Effect.Effect<{ readonly metadata: Artifact; readonly payload: Uint8Array }, ArtifactRetrieveError>
  head: (id: ArtifactId) => Effect.Effect<Artifact, ArtifactRetrieveError>
  delete: (id: ArtifactId) => Effect.Effect<void, ArtifactDeleteError>
}>() {}
