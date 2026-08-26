-- 0001_initial.sql
--
-- Ports dbschema/default.gel to PostgreSQL (ADR-018) and folds in the two ADR-005 violations
-- that schema carried: uuid_generate_v4() primary keys and `datetime` columns.
--
-- The property being preserved is that invalid state is unrepresentable at BOTH edges — Effect
-- Schema at the process boundary, constraints here at the storage boundary. Porting the tables
-- and dropping the constraints would have thrown away the reason Gel was chosen in the first place.

-- ---------------------------------------------------------------------------
-- UUIDv7
-- ---------------------------------------------------------------------------

-- PostgreSQL 18 ships uuidv7() natively. Until this database is on 18, generate it here so a
-- primary key can be defaulted without the application being in the loop. Drop this function and
-- the DEFAULTs keep working unchanged once the built-in exists.
--
-- Layout (RFC 9562): 48 bits of big-endian millisecond timestamp, 4 bits version, 12 bits random,
-- 2 bits variant, 62 bits random. Built by overlaying the timestamp onto a v4 UUID's first six
-- bytes and rewriting the version nibble; the variant bits gen_random_uuid() set are already
-- correct and are left alone.
--
-- Bit indices below are bytea bit numbering: bit n lives in byte n/8, counting from that byte's
-- least significant bit. The version nibble is therefore bits 52..55. gen_random_uuid() leaves
-- those as 0100 (version 4); setting bits 52 and 53 makes them 0111 (version 7).
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(
            int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
            FROM 3
          )
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

COMMENT ON FUNCTION uuidv7() IS
  'RFC 9562 UUIDv7. Shim for PostgreSQL < 18; ADR-005 requires time-sortable identifiers.';

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

-- Ported directly from the Gel scalar types. `trimmed` was an abstract constraint in Gel;
-- here it is inlined into each domain that extended it.
CREATE DOMAIN trimmed_string AS text
  CONSTRAINT trimmed_string_trimmed CHECK (VALUE = btrim(VALUE));

CREATE DOMAIN non_empty_string AS text
  CONSTRAINT non_empty_string_trimmed CHECK (VALUE = btrim(VALUE))
  CONSTRAINT non_empty_string_min CHECK (length(VALUE) >= 1);

CREATE DOMAIN short_string AS text
  CONSTRAINT short_string_trimmed CHECK (VALUE = btrim(VALUE))
  CONSTRAINT short_string_len CHECK (length(VALUE) BETWEEN 2 AND 80);

CREATE DOMAIN long_string AS text
  CONSTRAINT long_string_trimmed CHECK (VALUE = btrim(VALUE))
  CONSTRAINT long_string_len CHECK (length(VALUE) BETWEEN 2 AND 5000);

CREATE DOMAIN url AS text
  CONSTRAINT url_trimmed CHECK (VALUE = btrim(VALUE))
  CONSTRAINT url_len CHECK (length(VALUE) BETWEEN 5 AND 255)
  CONSTRAINT url_scheme CHECK (VALUE ~ '^(http|https)://\S+$');

-- This is what makes "UUIDv4 is forbidden" enforced rather than asserted: a v4 identifier cannot
-- be written to this database at all. The version nibble must be 7 and the variant nibble 8/9/a/b.
CREATE DOMAIN uuid_v7 AS uuid
  CONSTRAINT uuid_v7_version CHECK (
    VALUE::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );

-- ADR-005 timestamps: UNIX epoch seconds, integers, at every layer including this one.
-- See ADR-019 for why storage does not use timestamptz.
CREATE DOMAIN epoch_seconds AS bigint
  CONSTRAINT epoch_seconds_non_negative CHECK (VALUE >= 0);

-- ADR-018 listed Actor among the types to port as a native enum. It is a domain instead: the
-- qualified `user:andysakov` form keeps the multi-user seam open, and an enum cannot express it.
CREATE DOMAIN actor AS text
  CONSTRAINT actor_shape CHECK (VALUE ~ '^(user|metis)(:[a-z0-9._-]+)?$');

CREATE DOMAIN checksum AS text
  CONSTRAINT checksum_shape CHECK (VALUE ~ '^sha256:[0-9a-f]{64}$');

CREATE DOMAIN capability_id AS text
  CONSTRAINT capability_id_shape CHECK (
    VALUE ~ '^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*@[0-9]+\.[0-9]+$'
  );

-- Wider and more permissive than `url`: artifacts live at s3:// and file:// too.
CREATE DOMAIN artifact_uri AS text
  CONSTRAINT artifact_uri_shape CHECK (VALUE ~ '^[a-z][a-z0-9+.-]*://\S+$')
  CONSTRAINT artifact_uri_len CHECK (length(VALUE) <= 6400);

CREATE DOMAIN event_type AS text
  CONSTRAINT event_type_shape CHECK (VALUE ~ '^[A-Z][A-Z0-9_]*$');

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Lowercased from the Gel originals to match the wire format in specs/.
CREATE TYPE autonomy AS ENUM ('S0', 'S1', 'S2', 'S3', 'S4');
CREATE TYPE artifact_kind AS ENUM ('text', 'image', 'audio', 'video', 'file', 'link', 'code', 'binary');
CREATE TYPE plan_step_kind AS ENUM ('tool', 'ask', 'write', 'decision');
CREATE TYPE tagged_value_role AS ENUM ('input', 'constraint');

-- ---------------------------------------------------------------------------
-- updated_at trigger (Gel's `Timestamped` rewrite rule)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := floor(extract(epoch FROM clock_timestamp()))::bigint;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE project (
  id          uuid_v7       PRIMARY KEY DEFAULT uuidv7(),
  title       non_empty_string NOT NULL,
  description long_string,
  goal        long_string,
  created_at  epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint,
  updated_at  epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint
);

CREATE TRIGGER project_set_updated_at BEFORE UPDATE ON project
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE intent (
  id          uuid_v7       PRIMARY KEY DEFAULT uuidv7(),
  ts          epoch_seconds NOT NULL,
  actor       actor         NOT NULL,
  goal        long_string   NOT NULL,
  description long_string,
  autonomy    autonomy      NOT NULL DEFAULT 'S0',
  created_at  epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint,
  updated_at  epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint
);

CREATE TRIGGER intent_set_updated_at BEFORE UPDATE ON intent
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Intent inputs and constraints. A table rather than a jsonb blob because the tags are read by
-- policy — "does this intent carry untrusted input" has to be answerable as a query, and `ordinal`
-- keeps the caller's ordering, which a jsonb object would lose.
CREATE TABLE intent_value (
  intent_id uuid_v7           NOT NULL REFERENCES intent(id) ON DELETE CASCADE,
  role      tagged_value_role NOT NULL,
  ordinal   integer           NOT NULL CHECK (ordinal >= 0),
  name      non_empty_string  NOT NULL,
  value     jsonb             NOT NULL,
  tags      text[]            NOT NULL DEFAULT '{}',
  PRIMARY KEY (intent_id, role, ordinal)
);

CREATE INDEX intent_value_tags_idx ON intent_value USING gin (tags);

CREATE TABLE plan (
  id         uuid_v7       PRIMARY KEY DEFAULT uuidv7(),
  intent_id  uuid_v7       NOT NULL REFERENCES intent(id) ON DELETE CASCADE,
  created_at epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint,
  updated_at epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint
);

CREATE TRIGGER plan_set_updated_at BEFORE UPDATE ON plan
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX plan_intent_id_idx ON plan (intent_id);

-- Gel modelled Plan.steps as a multi-link, which does not preserve order. A plan's steps are a
-- sequence, so this is a foreign key plus an explicit ordinal.
CREATE TABLE plan_step (
  id                uuid_v7        PRIMARY KEY DEFAULT uuidv7(),
  plan_id           uuid_v7        NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  ordinal           integer        NOT NULL CHECK (ordinal >= 0),
  kind              plan_step_kind NOT NULL,
  description       long_string    NOT NULL,
  requires_approval boolean        NOT NULL DEFAULT false,
  -- Absent unless kind = 'tool'. Shape validated by Effect Schema at the process edge; the
  -- capability id is lifted out into its own column so the registry can be joined against.
  tool_capability   capability_id,
  tool_name         non_empty_string,
  tool_input        jsonb,
  tool_budget       jsonb,
  created_at        epoch_seconds  NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint,
  updated_at        epoch_seconds  NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint,
  UNIQUE (plan_id, ordinal),
  -- A tool step needs a capability and an input; a non-tool step must not carry either.
  CONSTRAINT plan_step_tool_call_shape CHECK (
    (kind = 'tool' AND tool_capability IS NOT NULL AND tool_input IS NOT NULL)
    OR (kind <> 'tool' AND tool_capability IS NULL AND tool_name IS NULL AND tool_input IS NULL)
  )
);

CREATE TRIGGER plan_step_set_updated_at BEFORE UPDATE ON plan_step
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Assumptions, risks and expected artifacts get identifiers so provenance can point at them
-- (ADR-001). Gel stored all three as opaque json, which made them unreferenceable.
CREATE TABLE plan_assumption (
  id          uuid_v7     PRIMARY KEY DEFAULT uuidv7(),
  plan_id     uuid_v7     NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  ordinal     integer     NOT NULL CHECK (ordinal >= 0),
  description long_string NOT NULL,
  tags        text[]      NOT NULL DEFAULT '{}',
  UNIQUE (plan_id, ordinal)
);

CREATE TABLE plan_risk (
  id          uuid_v7     PRIMARY KEY DEFAULT uuidv7(),
  plan_id     uuid_v7     NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  ordinal     integer     NOT NULL CHECK (ordinal >= 0),
  description long_string NOT NULL,
  tags        text[]      NOT NULL DEFAULT '{}',
  UNIQUE (plan_id, ordinal)
);

CREATE TABLE plan_artifact_expectation (
  id          uuid_v7       PRIMARY KEY DEFAULT uuidv7(),
  plan_id     uuid_v7       NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  ordinal     integer       NOT NULL CHECK (ordinal >= 0),
  kind        artifact_kind NOT NULL,
  description long_string   NOT NULL,
  tags        text[]        NOT NULL DEFAULT '{}',
  UNIQUE (plan_id, ordinal)
);

CREATE TABLE artifact (
  id          uuid_v7       PRIMARY KEY DEFAULT uuidv7(),
  kind        artifact_kind NOT NULL,
  title       non_empty_string NOT NULL CHECK (length(title) <= 200),
  description long_string,
  uri         artifact_uri  NOT NULL,
  checksum    checksum      NOT NULL,
  created_by  actor         NOT NULL,
  metadata    jsonb         NOT NULL DEFAULT '{}',
  created_at  epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint,
  updated_at  epoch_seconds NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp()))::bigint
);

CREATE TRIGGER artifact_set_updated_at BEFORE UPDATE ON artifact
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Gel's Artifact.in_project multi-link.
CREATE TABLE artifact_project (
  artifact_id uuid_v7 NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  project_id  uuid_v7 NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, project_id)
);

-- Gel's Plan.artifacts multi-link: artifacts a plan actually produced.
CREATE TABLE plan_artifact (
  plan_id     uuid_v7 NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  artifact_id uuid_v7 NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, artifact_id)
);

-- ADR-001's provenance rules: every artifact records what it came from. The relation vocabulary
-- stays open (derives_from, produced_by, justified_by, in_project) but the shape is fixed, because
-- an untyped blob would make the takedown-cascade requirement in Limits & Guardrails §6
-- unimplementable — you cannot cascade a deletion through relationships you cannot query.
CREATE TABLE artifact_provenance (
  artifact_id uuid_v7          NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  rel         non_empty_string NOT NULL CHECK (rel ~ '^[a-z][a-z0-9_]*$'),
  ref         non_empty_string NOT NULL,
  PRIMARY KEY (artifact_id, rel, ref)
);

CREATE INDEX artifact_provenance_ref_idx ON artifact_provenance (ref);

-- The event log. Append-only and idempotent by id (ADR-007): a repeated append is one event,
-- which the primary key gives us via ON CONFLICT DO NOTHING.
--
-- This is METIS's own audit record and is deliberately separate from Restate's execution
-- journal (ADR-016). Do not merge them.
CREATE TABLE event (
  id             uuid_v7       PRIMARY KEY,
  ts             epoch_seconds NOT NULL,
  type           event_type    NOT NULL,
  actor          actor         NOT NULL,
  project_id     uuid_v7       REFERENCES project(id) ON DELETE SET NULL,
  correlation_id uuid_v7,
  payload        jsonb         NOT NULL
);

-- The log is read as a time range, usually filtered by type. Identifier breaks ties within a
-- second: UUIDv7 sorts by creation time, which is the whole reason ADR-005 requires it.
CREATE INDEX event_ts_id_idx ON event (ts, id);
CREATE INDEX event_type_ts_idx ON event (type, ts);
CREATE INDEX event_correlation_id_idx ON event (correlation_id) WHERE correlation_id IS NOT NULL;
