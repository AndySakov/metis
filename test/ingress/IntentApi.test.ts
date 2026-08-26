import { FetchHttpClient, HttpApiBuilder, HttpApiClient } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Layer as L, ManagedRuntime, Schema } from "effect"
import { createServer } from "node:http"

import type { Actor, Autonomy } from "../../src/domain/Common.js"
import type { PlanId } from "../../src/domain/Plan.js"
import { Plan } from "../../src/domain/Plan.js"
import { Policy } from "../../src/domain/Policy.js"
import { TrustPolicy } from "../../src/domain/Trust.js"
import { IntentApi } from "../../src/ingress/IntentApi.js"
import { ApiLive } from "../../src/ingress/IntentApiLive.js"
import { EventLogStore } from "../../src/mneme/EventLogStore.js"
import * as InMemoryArtifactStore from "../../src/mneme/InMemoryArtifactStore.js"
import * as InMemoryEventLogStore from "../../src/mneme/InMemoryEventLogStore.js"
import * as InMemoryPlanStore from "../../src/mneme/InMemoryPlanStore.js"
import * as PlanExecution from "../../src/orchestrator/PlanExecution.js"
import * as Planner from "../../src/orchestrator/Planner.js"
import * as PolicyEngine from "../../src/policy/PolicyEngine.js"
import * as PolicyGate from "../../src/policy/PolicyGate.js"
import * as TrustLedger from "../../src/policy/TrustLedger.js"
import * as Verification from "../../src/policy/Verification.js"
import * as ToolRegistry from "../../src/tools/ToolRegistry.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/** The client is typed against branded schemas; tests supply literals through these. */
const actor = "user:andysakov" as Actor
const gear = (g: string) => g as Autonomy
const planId = (id: string) => id as PlanId

/**
 * The API over a real HTTP server and a real client.
 *
 * Calling handler functions directly would skip serialisation, routing and status codes — which is
 * where the interesting failures live. This starts a server on an ephemeral port and talks to it.
 */

const PORT = 8_099

/**
 * The API with the **direct** execution path.
 *
 * Deliberately not Restate: this file tests the HTTP surface, and standing up a durable engine to
 * do that would make the test slow and would not exercise anything the surface owns. The durable
 * path has its own test in `test/orchestrator/Restate.test.ts`. What matters here is that the
 * endpoint reports which mode it used.
 */
const permissivePolicy = Schema.decodeUnknownSync(Policy)({
  version: "api-1",
  defaultEffect: "allow",
  rules: []
})

const trustPolicy = Schema.decodeUnknownSync(TrustPolicy)({
  decay: { competenceHalfLifeSeconds: 2_592_000, complianceHalfLifeSeconds: 1_209_600 },
  thresholds: []
})

const stores = Layer.merge(InMemoryEventLogStore.layer, InMemoryArtifactStore.layer)
const engine = PolicyEngine.layer(permissivePolicy)
const gate = Layer.provide(PolicyGate.layer, Layer.merge(engine, stores))

/** No tools are registered, so an executed step fails to resolve — enough to prove the path runs. */
const executionDeps = L.mergeAll(
  stores,
  gate,
  ToolRegistry.layer([]),
  Layer.succeed(ToolRunner, {
    run: () => Effect.die("no tool runner configured for the API test")
  } as never),
  TrustLedger.layer(trustPolicy, []),
  Verification.neverSample
)

const AppLive = ApiLive.pipe(
  Layer.provide(Layer.provide(PlanExecution.directLayer, executionDeps)),
  Layer.provide(InMemoryPlanStore.layer),
  Layer.provide(Planner.layer),
  Layer.provide(InMemoryEventLogStore.layer),
  Layer.provide(InMemoryArtifactStore.layer)
)

const ServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(AppLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: PORT }))
)

const runtime = ManagedRuntime.make(
  Layer.mergeAll(ServerLive, InMemoryEventLogStore.layer, FetchHttpClient.layer)
)

const client = Effect.gen(function*() {
  return yield* HttpApiClient.make(IntentApi, { baseUrl: `http://127.0.0.1:${PORT}` })
})

/**
 * Polls until the port answers.
 *
 * Without this the negative tests are worthless: a refused connection is also a failure, so
 * `expect(outcome._tag).toBe("Left")` passes just as happily when the server never started. An
 * assertion that cannot tell "rejected by validation" from "nothing listening" is not testing
 * validation.
 */
const waitForListener = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/plans/01890a5d-0000-7000-8000-000000000000`)
      return
    } catch {
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  throw new Error(`server never started on port ${PORT}`)
}

// File-scope hooks: the server is started once and disposed once. Scoping them to the first
// `describe` would tear the runtime down before the later blocks ran.
beforeAll(async () => {
  // ManagedRuntime builds layers lazily, so running a no-op would not start the listener.
  // Forcing the runtime builds every layer, including the server.
  await runtime.runtime()
  await waitForListener()
}, 20_000)

afterAll(async () => {
  await runtime.dispose()
}, 20_000)

describe("POST /intent", () => {
  it("turns a draft into a plan, assigning id and timestamp server-side", async () => {
    const plan = await runtime.runPromise(
      Effect.gen(function*() {
        const api = yield* client
        return yield* api.intent.createPlan({
          payload: {
            actor,
            goal: "Draft a PRD for a research summarizer",
            autonomy: gear("S1"),
            inputs: [],
            constraints: []
          }
        })
      }) as Effect.Effect<Plan>
    )

    // The client never supplied these; the server is authoritative for both (ADR-005).
    expect(plan.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(plan.intentId).toMatch(/-7[0-9a-f]{3}-/)
    expect(plan.createdAt).toBeGreaterThan(0)
    expect(plan.steps.length).toBe(3)

    // And it round-trips the canonical schema after crossing the wire.
    expect(() => Schema.decodeUnknownSync(Plan)(Schema.encodeSync(Plan)(plan))).not.toThrow()
  }, 20_000)

  it("rejects a draft that supplies an id, because that is not the client's to set", async () => {
    const outcome = await runtime.runPromise(
      Effect.either(
        Effect.gen(function*() {
          const api = yield* client
          return yield* api.intent.createPlan({
            payload: {
              actor,
              goal: "Draft a PRD",
              autonomy: gear("S1"),
              id: "01890a5d-ac96-774b-bcce-b302099a8057"
            } as never
          })
        })
      ) as Effect.Effect<any>
    )
    expect(outcome._tag).toBe("Left")
    // Specifically a validation failure, not a transport failure.
    expect(String((outcome as { left: unknown }).left)).not.toContain("ECONNREFUSED")
  }, 20_000)

  it("rejects an unknown autonomy gear", async () => {
    const outcome = await runtime.runPromise(
      Effect.either(
        Effect.gen(function*() {
          const api = yield* client
          return yield* api.intent.createPlan({
            payload: { actor, goal: "Draft a PRD", autonomy: "S9" } as never
          })
        })
      ) as Effect.Effect<any>
    )
    expect(outcome._tag).toBe("Left")
    expect(String((outcome as { left: unknown }).left)).not.toContain("ECONNREFUSED")
  }, 20_000)

  it("records the intent and the plan in the event log", async () => {
    const events = await runtime.runPromise(
      Effect.gen(function*() {
        const api = yield* client
        yield* api.intent.createPlan({
          payload: { actor, goal: "Research RAG", autonomy: gear("S1"), inputs: [], constraints: [] }
        })
        const log = yield* EventLogStore
        return yield* Effect.orDie(log.read({}))
      }) as unknown as Effect.Effect<Array<{ type: string }>>
    )

    // The audit trail exists whether or not the plan is ever executed.
    const types = events.map((e) => e.type)
    expect(types).toContain("INTENT_RECEIVED")
    expect(types).toContain("PLAN_CREATED")
  }, 20_000)
})

describe("GET /plans/:id", () => {
  it("returns a plan that was created, and 404s one that was not", async () => {
    const { fetched, missing } = await runtime.runPromise(
      Effect.gen(function*() {
        const api = yield* client
        const created = yield* api.intent.createPlan({
          payload: { actor, goal: "Draft a PRD", autonomy: gear("S1"), inputs: [], constraints: [] }
        })
        const fetched = yield* api.intent.getPlan({ path: { id: created.id } })
        const missing = yield* Effect.either(
          api.intent.getPlan({ path: { id: planId("01890a5d-0000-7000-8000-000000000000") } })
        )
        return { fetched, missing }
      }) as Effect.Effect<any>
    )

    expect(fetched.steps.length).toBe(3)
    expect(missing._tag).toBe("Left")
  }, 20_000)
})

describe("the wire contract, independent of the typed client", () => {
  /**
   * The generated client's payload type requires `inputs` and `constraints` because
   * `Schema.optionalWith(..., { default })` makes them present on the decoded type. The HTTP
   * contract does not — `IntentDraft.schema.json` marks them optional with a default, and a caller
   * writing JSON by hand should be able to omit them. That gap between the client's ergonomics and
   * the actual contract is only visible from outside the client, so this posts raw JSON.
   */
  it("accepts a minimal body with only actor and goal", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "user:andysakov", goal: "Draft a PRD" })
    })

    expect(response.status).toBe(201)
    const plan = await response.json() as { steps: Array<unknown> }
    expect(plan.steps.length).toBe(3)
  }, 20_000)

  it("defaults autonomy to S0 when omitted — the gear that cannot cause a side effect", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "user:andysakov", goal: "Draft a PRD" })
    })

    const plan = await response.json() as { steps: Array<{ requiresApproval: boolean }> }
    // S0 gates every tool step, so an omitted gear must not execute anything unattended.
    expect(plan.steps.every((step) => step.requiresApproval)).toBe(true)
  }, 20_000)

  it("rejects a malformed body rather than guessing", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "root", goal: "" })
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  }, 20_000)
})

describe("POST /plans/:id/execute", () => {
  it("submits a plan and reports which execution mode ran it", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "user:andysakov", goal: "Draft a PRD", autonomy: "S2" })
    })
    const plan = await response.json() as { id: string }

    const executed = await fetch(`http://127.0.0.1:${PORT}/plans/${plan.id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    })

    expect(executed.status).toBe(202)
    const submission = await executed.json() as { mode: string; executionId: string; status: string }

    // `mode` is the point of this endpoint's contract: a caller must be able to tell a durable run
    // from an in-process one, because only one of them survives a restart.
    expect(submission.mode).toBe("direct")
    expect(submission.executionId).toMatch(/-7[0-9a-f]{3}-/)
    expect(submission.status).toBeDefined()
  }, 20_000)

  it("404s a plan that does not exist", async () => {
    const executed = await fetch(
      `http://127.0.0.1:${PORT}/plans/01890a5d-0000-7000-8000-000000000000/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }
    )
    expect(executed.status).toBeGreaterThanOrEqual(400)
  }, 20_000)

  it("records the submission in the event log", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "user:andysakov", goal: "Draft a PRD", autonomy: "S2" })
    })
    const plan = await response.json() as { id: string }

    await fetch(`http://127.0.0.1:${PORT}/plans/${plan.id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    })

    const events = await runtime.runPromise(
      Effect.gen(function*() {
        const log = yield* EventLogStore
        return yield* Effect.orDie(log.read({}))
      }) as unknown as Effect.Effect<Array<{ type: string; payload: unknown }>>
    )

    const submitted = events.find((e) => e.type === "PLAN_SUBMITTED")
    expect(submitted, "submission must be auditable").toBeDefined()
    expect((submitted!.payload as { mode: string }).mode).toBe("direct")
  }, 20_000)
})
