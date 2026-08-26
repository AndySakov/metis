# ADR-019: Epoch Seconds All The Way Down

Status: Accepted
Closes: the open question ADR-018 deferred to the Postgres port

## Context

ADR-005 requires UNIX epoch seconds as integers in all public schemas. It did not say what storage
should do, and ADR-018 explicitly left the choice open:

> `datetime` columns → **epoch-second integers**, or amend ADR-005 to permit `timestamptz` in
> storage with integers at the API boundary. Decide during the port and record the choice.

The port has landed. This records the choice.

## Decision

**Epoch seconds, as `bigint`, at every layer — including storage.**

A `epoch_seconds` domain with a `CHECK (VALUE >= 0)` constraint is the column type for every
timestamp in `migrations/0001_initial.sql`. No `timestamptz` anywhere.

Two naming conventions, applied consistently:

- `ts` on records of a moment — `Event.ts`, `Intent.ts`. The thing happened at that instant and the
  timeline is ordered by it.
- `created_at` / `updated_at` on entities that persist and change — `Plan`, `Artifact`, `Project`.
  `updated_at` is maintained by a trigger, replacing Gel's `rewrite` rule.

## Rationale

The alternative — `timestamptz` in storage, integers at the API boundary — means a conversion on
every read and every write, in both directions, forever. Every one of those conversions is a place
the two representations can disagree, and this repository has just spent a full audit fixing
exactly that class of divergence between a spec and its implementation. Adding a new one at the
storage seam, on purpose, on day one, would be a poor trade.

The API contract is already fixed by ADR-005: `fromTs` and `toTs` query parameters are integers,
`Event.ts` is an integer. Making storage match means a range scan is a plain integer comparison
against an indexed `bigint` column, with no casting between the query parameter and the column.

What is given up is real and worth stating plainly: `WHERE created_at > now() - interval '7 days'`
does not work, and `psql` prints `1735872000` rather than a readable date. The mitigation is
`to_timestamp(ts)` at the point of a human query, and an expression index if such a query ever
becomes hot. That is a cost paid by the person typing ad-hoc SQL, which is a much smaller
population than the code paths that would otherwise carry conversions.

Seconds rather than milliseconds because ADR-005 said seconds. Sub-second ordering is served by the
identifier: UUIDv7 embeds a millisecond timestamp and sorts lexicographically, so `(ts, id)` gives
a total order finer than the `ts` column alone. This is the reason ADR-005 required time-sortable
identifiers, and it is why the event log's primary index is `(ts, id)`.

## Consequences

- ADR-005 is unchanged and now holds at every layer rather than only at the boundary.
- Date arithmetic in SQL requires `to_timestamp()`. Accepted.
- Timestamps are `bigint`, not `integer`. `integer` overflows in 2038; a project describing itself
  as decade-long should not ship a 2038 bug in its first migration.
- A future need for millisecond precision is an additive migration on specific columns, not a
  representation change — the units are documented per column rather than assumed.

## References

- ADR-005 Identifiers & Timestamps
- ADR-018 Datastore — Bare-Metal PostgreSQL
- `migrations/0001_initial.sql`
- `specs/common/Timestamp.schema.json`
