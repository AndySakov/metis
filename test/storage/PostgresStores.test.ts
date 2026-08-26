import * as PgClient from "@effect/sql-pg/PgClient"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Config, Effect, Layer, Redacted } from "effect"
import pg from "pg"

import { loadMigrations, migrate } from "../../src/db/Migrator.js"
import * as PostgresArtifactStore from "../../src/mneme/PostgresArtifactStore.js"
import * as PostgresEventLogStore from "../../src/mneme/PostgresEventLogStore.js"
import { loadVectors, runArtifactVector, runEventLogVector } from "./Conformance.js"

/**
 * The Postgres adapters run the **same** conformance vectors as the in-memory ones.
 *
 * That is the point of driving the vectors from spec files: "the durable store behaves like the
 * reference" stops being a claim and becomes a test. A divergence — different ordering, a
 * different idempotency rule, a checksum that is not actually verified — fails here.
 *
 * Skipped when no database is reachable, so the suite stays green on a machine without Postgres.
 * Set `METIS_TEST_POSTGRES=1` to make a missing database a failure instead of a skip, which is
 * what CI should do once it runs a Postgres service.
 */

const HOST = process.env.PGHOST ?? "/tmp"
const USER = process.env.PGUSER ?? process.env.USER ?? "postgres"
const PASSWORD = process.env.PGPASSWORD ?? ""
const TEST_DB = "metis_conformance_test"
const REQUIRED = process.env.METIS_TEST_POSTGRES === "1"

const adminClient = () => new pg.Client({ host: HOST, user: USER, password: PASSWORD, database: "postgres" })

const canConnect = async (): Promise<boolean> => {
  const client = adminClient()
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    return false
  }
}

/** Drops and recreates the test database, then applies every migration. */
const resetDatabase = async (): Promise<void> => {
  const admin = adminClient()
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
  await admin.query(`CREATE DATABASE ${TEST_DB}`)
  await admin.end()

  const target = new pg.Client({ host: HOST, user: USER, password: PASSWORD, database: TEST_DB })
  await target.connect()
  const migrations = await Effect.runPromise(loadMigrations("migrations"))
  await Effect.runPromise(migrate(target, migrations) as Effect.Effect<Array<string>>)
  await target.end()
}

const dropDatabase = async (): Promise<void> => {
  const admin = adminClient()
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
  await admin.end()
}

const clientLayer = PgClient.layerConfig({
  host: Config.succeed(HOST),
  username: Config.succeed(USER),
  password: Config.succeed(Redacted.make(PASSWORD)),
  database: Config.succeed(TEST_DB)
})

/** Truncates between vectors — each vector asserts over the whole store. */
const truncate = async (): Promise<void> => {
  const client = new pg.Client({ host: HOST, user: USER, password: PASSWORD, database: TEST_DB })
  await client.connect()
  await client.query("TRUNCATE event, artifact_payload, artifact_provenance, artifact CASCADE")
  await client.end()
}

const available = await canConnect()

if (!available && !REQUIRED) {
  describe.skip("Postgres adapters (no database reachable)", () => {
    it("skipped", () => {})
  })
} else {
  describe("Postgres adapters pass the same conformance vectors", () => {
    beforeAll(async () => {
      expect(available, `METIS_TEST_POSTGRES=1 but no database at ${HOST}`).toBe(true)
      await resetDatabase()
    }, 60_000)

    afterAll(async () => {
      await dropDatabase()
    }, 60_000)

    for (const vector of loadVectors("eventlog")) {
      it(`eventlog: ${vector.name}`, async () => {
        await truncate()
        await Effect.runPromise(
          runEventLogVector(vector).pipe(
            Effect.provide(Layer.provide(PostgresEventLogStore.layer, clientLayer))
          ) as Effect.Effect<void>
        )
      })
    }

    for (const vector of loadVectors("artifact")) {
      it(`artifact: ${vector.name}`, async () => {
        await truncate()
        await Effect.runPromise(
          runArtifactVector(vector).pipe(
            Effect.provide(Layer.provide(PostgresArtifactStore.layer, clientLayer))
          ) as Effect.Effect<void>
        )
      })
    }
  })
}
