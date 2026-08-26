import { Schema } from "effect"

import { Actor, ArtifactKind, EpochSeconds, LongText, ShortText, Uuid7 } from "./Common.js"

export const ArtifactId = Uuid7.pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type

/** Content hash of the payload. Pinning the algorithm prefix means a checksum can be verified, not just stored. */
export const Checksum = Schema.String.pipe(
  Schema.pattern(/^sha256:[0-9a-f]{64}$/),
  Schema.brand("Checksum"),
  Schema.annotations({ identifier: "Checksum", description: "sha256:<64 hex>" })
)
export type Checksum = typeof Checksum.Type

/** Where the bytes live. Any scheme — `s3://`, `file://`, `https://`. */
export const ArtifactUri = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9+.-]*:\/\/\S+$/),
  Schema.maxLength(6400),
  Schema.brand("ArtifactUri")
)
export type ArtifactUri = typeof ArtifactUri.Type

/**
 * A typed link back to what an artifact came from (ADR-001).
 *
 * The relation vocabulary stays open — known values are `derives_from`, `produced_by`,
 * `justified_by`, `in_project` — but the shape is fixed, because an untyped blob here would make
 * the provenance rules unimplementable.
 */
export class ProvenanceLink extends Schema.Class<ProvenanceLink>("ProvenanceLink")({
  rel: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]*$/)),
  /** An Identifier of another METIS entity, or an external URI. */
  ref: Schema.NonEmptyTrimmedString
}) {}

/**
 * The metadata record for a stored blob. The only thing named Artifact in METIS.
 *
 * It never carries the bytes. ADR-007 gives the store `get(id) -> {bytes, metadata}` and
 * `head(id) -> metadata` precisely so metadata can be listed, referenced and returned from the API
 * without moving payloads. A thing a plan intends to produce but has not produced yet is an
 * `ArtifactExpectation` (see Plan.ts) — it cannot be an Artifact, having no bytes to checksum.
 */
export class Artifact extends Schema.Class<Artifact>("Artifact")({
  id: ArtifactId,
  kind: ArtifactKind,
  title: ShortText,
  description: Schema.optional(LongText),
  uri: ArtifactUri,
  checksum: Checksum,
  createdAt: EpochSeconds,
  createdBy: Actor,
  metadata: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.Unknown }), {
    default: () => ({})
  }),
  provenance: Schema.optionalWith(Schema.Array(ProvenanceLink), { default: () => [] })
}) {}
