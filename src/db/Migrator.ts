import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Schema } from "effect"
import type pg from "pg"

/**
 * Plain numbered SQL migrations with a simple runner (ADR-018).
 *
 * No migration DSL. A system meant to run for years wants migrations that are readable in ten
 * years without a tool that may not exist by then, so the files are SQL and this only sequences
 * them.
 *
 * Two properties matter. Each file applies inside one transaction, so a failure leaves nothing
 * half-applied. And the checksum of every applied file is recorded and re-verified, so editing a
 * migration that already ran is an error rather than a silent divergence between what the
 * database contains and what the repository claims it contains.
 */

const MIGRATIONS_TABLE = "schema_migrations"

/** `0001_initial.sql` -> version `0001`. Ordering is by filename, which is why they are zero-padded. */
const VERSION_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/

export class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  version: Schema.String,
  message: Schema.String
}) {}

export class MigrationDriftError extends Schema.TaggedError<MigrationDriftError>()("MigrationDriftError", {
  version: Schema.String,
  message: Schema.String
}) {}

export interface Migration {
  readonly version: string
  readonly name: string
  readonly sql: string
  readonly checksum: string
}

const checksumOf = (sql: string): string => `sha256:${createHash("sha256").update(sql, "utf8").digest("hex")}`

/** Reads and orders the migration files. Rejects anything not matching the numbering convention. */
export const loadMigrations = (dir: string): Effect.Effect<Array<Migration>, MigrationError> =>
  Effect.gen(function*() {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(dir),
      catch: (cause) => new MigrationError({ version: "-", message: `cannot read ${dir}: ${String(cause)}` })
    })

    const sqlFiles = entries.filter((name) => name.endsWith(".sql")).sort()

    const migrations: Array<Migration> = []
    for (const name of sqlFiles) {
      const matched = VERSION_PATTERN.exec(name)
      if (matched === null) {
        return yield* new MigrationError({
          version: name,
          message: `filename must look like 0001_snake_case.sql`
        })
      }
      const sql = yield* Effect.tryPromise({
        try: () => readFile(join(dir, name), "utf8"),
        catch: (cause) => new MigrationError({ version: name, message: String(cause) })
      })
      migrations.push({ version: matched[1]!, name, sql, checksum: checksumOf(sql) })
    }

    const seen = new Set<string>()
    for (const migration of migrations) {
      if (seen.has(migration.version)) {
        return yield* new MigrationError({
          version: migration.version,
          message: "duplicate migration version"
        })
      }
      seen.add(migration.version)
    }

    return migrations
  })

/**
 * Applies every migration that has not run yet, in order.
 *
 * Returns the versions it applied — empty when the database was already current.
 */
export const migrate = (
  client: pg.ClientBase,
  migrations: ReadonlyArray<Migration>
): Effect.Effect<Array<string>, MigrationError | MigrationDriftError> =>
  Effect.gen(function*() {
    const exec = (sql: string, params?: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () => client.query(sql, params as Array<unknown> | undefined),
        catch: (cause) => new MigrationError({ version: "-", message: String(cause) })
      })

    yield* exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         version    text   PRIMARY KEY,
         name       text   NOT NULL,
         checksum   text   NOT NULL,
         applied_at bigint NOT NULL
       )`
    )

    const applied = yield* exec(`SELECT version, name, checksum FROM ${MIGRATIONS_TABLE}`)
    const appliedByVersion = new Map(
      applied.rows.map((row) => [String(row.version), { name: String(row.name), checksum: String(row.checksum) }])
    )

    const appliedNow: Array<string> = []

    for (const migration of migrations) {
      const previous = appliedByVersion.get(migration.version)

      if (previous !== undefined) {
        // Already run. The file must not have changed since — otherwise the schema in the database
        // and the schema described by this repository have quietly diverged.
        if (previous.checksum !== migration.checksum) {
          return yield* new MigrationDriftError({
            version: migration.version,
            message: `${migration.name} was modified after it was applied (recorded ${previous.checksum}, ` +
              `found ${migration.checksum}). Write a new migration instead of editing an applied one.`
          })
        }
        continue
      }

      yield* exec("BEGIN")
      const outcome = yield* Effect.either(
        Effect.gen(function*() {
          yield* exec(migration.sql)
          yield* exec(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at)
             VALUES ($1, $2, $3, floor(extract(epoch FROM clock_timestamp()))::bigint)`,
            [migration.version, migration.name, migration.checksum]
          )
        })
      )

      if (outcome._tag === "Left") {
        yield* Effect.orDie(Effect.ignore(exec("ROLLBACK")))
        return yield* new MigrationError({
          version: migration.version,
          message: `${migration.name} failed and was rolled back: ${outcome.left.message}`
        })
      }

      yield* exec("COMMIT")
      appliedNow.push(migration.version)
    }

    return appliedNow
  })
