-- 0002_artifact_payload.sql
--
-- Bytes for artifacts the ArtifactStore holds itself.
--
-- `artifact.uri` records where an artifact logically lives, and for artifacts produced and kept by
-- METIS that address is `metis://artifact/<id>`. The bytes behind such an address live here. An
-- artifact whose uri points somewhere external (an https:// source that was fetched, an s3://
-- bucket owned by something else) has metadata and provenance in `artifact` with no row here.
--
-- Kept in a separate table rather than a column on `artifact` so that reading metadata never pulls
-- a payload off disk. ADR-007 separates `head` from `get` for exactly that reason, and a bytea
-- column on the main table would defeat it — Postgres would still have to skip past the TOAST
-- pointer on every metadata scan, and any `SELECT *` would quietly transfer blobs.

CREATE TABLE artifact_payload (
  artifact_id uuid_v7 PRIMARY KEY REFERENCES artifact(id) ON DELETE CASCADE,
  bytes       bytea   NOT NULL,
  -- Denormalised so integrity can be checked without joining, and so a mismatch between the
  -- stored length and the actual payload is visible in a single query.
  byte_length integer NOT NULL CHECK (byte_length >= 0),
  CONSTRAINT artifact_payload_length_matches CHECK (octet_length(bytes) = byte_length)
);

COMMENT ON TABLE artifact_payload IS
  'Bytes for artifacts stored inline by METIS. Separate from `artifact` so metadata reads never transfer payloads (ADR-007).';
