import * as PgClient from "@effect/sql-pg/PgClient"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import pg from "pg"

import { loadMigrations, migrate } from "../../src/db/Migrator.js"
import { Intent } from "../../src/domain/Intent.js"
import type { Plan } from "../../src/domain/Plan.js"
import { PlanStore } from "../../src/mneme/PlanStore.js"
import * as PostgresPlanStore from "../../src/mneme/PostgresPlanStore.js"
import * as Planner from "../../src/orchestrator/Planner.js"

/**
 * Plans must survive a restart.
 *
 * The test writes through one connection and reads through a fresh one, because reading back from
 * the same in-process handle would pass even if nothing had reached the database.
 */

const HOST = process.env.PGHOST ?? "/tmp"
const USER = process.env.PGUSER ?? process.env.USER ?? "postgres"
const PASSWORD = process.env.PGPASSWORD ?? ""
const TEST_DB = "metis_planstore_test"
const REQUIRED = process.env.METIS_TEST_POSTGRES === "1"

const admin = () => new pg.Client({ host: HOST, user: USER, password: PASSWORD, database: "postgres" })

const canConnect = async (): Promise<boolean> => {
  const client = admin()
  try {
    await client.connect()
    await client.end()
    return true
  } catch {
    return false
  }
}

const clientLayer = PgClient.layerConfig({
  host: Config.succeed(HOST),
  username: Config.succeed(USER),
  password: Config.succeed(Redacted.make(PASSWORD)),
  database: Config.succeed(TEST_DB)
})

const stack = Layer.provide(PostgresPlanStore.layer, clientLayer)

const intent = Schema.decodeUnknownSync(Intent)({
  id: "01890a5d-ac96-774b-bcce-b302099a8057",
  ts: 1735872000,
  actor: "user:andysakov",
  goal: "Draft a PRD for a research summarizer",
  description: "Something durable",
  autonomy: "S3",
  inputs: [{ name: "source", value: "https://example.com", tags: ["untrusted", "web"] }],
  constraints: [{ name: "max_pages", value: 3, tags: ["hard"] }]
})

const available = await canConnect()

if (!available && !REQUIRED) {
  describe.skip("PostgresPlanStore (no database reachable)", () => {
    it("skipped", () => {})
  })
} else {
  describe("PostgresPlanStore", () => {
    beforeAll(async () => {
      const a = admin()
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
      await a.query(`CREATE DATABASE ${TEST_DB}`)
      await a.end()

      const target = new pg.Client({ host: HOST, user: USER, password: PASSWORD, database: TEST_DB })
      await target.connect()
      const migrations = await Effect.runPromise(loadMigrations("migrations"))
      await Effect.runPromise(migrate(target, migrations) as Effect.Effect<Array<string>>)
      await target.end()
    }, 60_000)

    afterAll(async () => {
      const a = admin()
      await a.connect()
      await a.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
      await a.end()
    }, 60_000)

    it("round-trips a plan through the database, not through memory", async () => {
      const plan = await Effect.runPromise(
        Effect.gen(function*() {
          const planner = yield* Planner.Planner
          return yield* planner.plan(intent)
        }).pipe(Effect.provide(Planner.layer))
      )

      // Written with one connection...
      await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* PlanStore
          yield* Effect.orDie(store.put(intent, plan))
        }).pipe(Effect.provide(stack)) as Effect.Effect<void>
      )

      // ...read back with another, so nothing can be served from a live handle.
      const readBack = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* PlanStore
          return {
            plan: yield* Effect.orDie(store.getPlan(plan.id)),
            intent: yield* Effect.orDie(store.getIntent(intent.id))
          }
        }).pipe(Effect.provide(stack)) as Effect.Effect<{ plan: Plan | undefined; intent: Intent | undefined }>
      )

      expect(readBack.plan).toBeDefined()
      expect(readBack.intent).toBeDefined()

      // Step order is the plan's, preserved by ordinal rather than by identifier luck.
      expect(readBack.plan!.steps.map((s) => s.description)).toEqual(plan.steps.map((s) => s.description))
      expect(readBack.plan!.steps.map((s) => s.toolCall?.capability)).toEqual(
        plan.steps.map((s) => s.toolCall?.capability)
      )
      expect(readBack.plan!.steps.every((s) => s.requiresApproval)).toBe(true)

      expect(readBack.plan!.assumptions.length).toBe(plan.assumptions.length)
      expect(readBack.plan!.risks.length).toBe(plan.risks.length)
      expect(readBack.plan!.expectedArtifacts.length).toBe(plan.expectedArtifacts.length)
    }, 30_000)

    it("preserves the trust tags policy reads", async () => {
      const readBack = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* PlanStore
          return yield* Effect.orDie(store.getIntent(intent.id))
        }).pipe(Effect.provide(stack)) as Effect.Effect<Intent | undefined>
      )

      // If tags were lost on the way through the database, policy would silently stop seeing
      // untrusted input after a restart — a safety regression that reads as a serialisation detail.
      const source = readBack!.inputs.find((i) => i.name === "source")
      expect(source?.tags).toEqual(["untrusted", "web"])
      expect(readBack!.constraints[0]?.tags).toEqual(["hard"])
      expect(readBack!.description).toBe("Something durable")
    }, 30_000)

    it("is idempotent: writing the same plan twice is one plan", async () => {
      const plan = await Effect.runPromise(
        Effect.gen(function*() {
          const planner = yield* Planner.Planner
          return yield* planner.plan(intent)
        }).pipe(Effect.provide(Planner.layer))
      )

      await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* PlanStore
          yield* Effect.orDie(store.put(intent, plan))
          yield* Effect.orDie(store.put(intent, plan))
        }).pipe(Effect.provide(stack)) as Effect.Effect<void>
      )

      const readBack = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* PlanStore
          return yield* Effect.orDie(store.getPlan(plan.id))
        }).pipe(Effect.provide(stack)) as Effect.Effect<Plan | undefined>
      )

      expect(readBack!.steps.length).toBe(plan.steps.length)
    }, 30_000)

    it("returns undefined for a plan that does not exist", async () => {
      const missing = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* PlanStore
          return yield* Effect.orDie(store.getPlan("01890a5d-0000-7000-8000-000000000000" as Plan["id"]))
        }).pipe(Effect.provide(stack)) as Effect.Effect<Plan | undefined>
      )
      expect(missing).toBeUndefined()
    }, 30_000)
  })
}
