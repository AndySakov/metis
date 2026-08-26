import { Config, Effect, Redacted } from "effect"
import pg from "pg"

import { PostgresConfig } from "../config/Config.js"
import { loadMigrations, migrate } from "./Migrator.js"

/**
 * `pnpm migrate` — apply any migrations the database has not seen yet.
 *
 * Safe to run repeatedly: already-applied migrations are skipped, and one whose file changed after
 * it was applied fails loudly rather than being silently re-run or ignored.
 */
const main = Effect.gen(function*() {
  const settings = yield* PostgresConfig
  const directory = yield* Config.string("MIGRATIONS_DIR").pipe(Config.withDefault("migrations"))

  const migrations = yield* loadMigrations(directory)

  const client = new pg.Client({
    host: settings.host,
    port: settings.port,
    user: settings.username,
    password: Redacted.value(settings.password),
    database: settings.database
  })

  yield* Effect.tryPromise({
    try: () => client.connect(),
    catch: (cause) => new Error(`cannot connect to ${settings.database}: ${String(cause)}`)
  })

  const applied = yield* Effect.ensuring(
    migrate(client, migrations),
    Effect.promise(() => client.end())
  )

  yield* applied.length === 0
    ? Effect.log(`database is current (${migrations.length} migration(s) already applied)`)
    : Effect.log(`applied ${applied.length} migration(s): ${applied.join(", ")}`)
})

Effect.runPromise(main).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
