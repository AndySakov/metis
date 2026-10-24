import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import type { Artifact, ArtifactId } from "../../src/domain/Artifact.js"
import { ApiLive } from "../../src/ingress/IntentApiLive.js"
import { ArtifactRetrieveError, ArtifactStore } from "../../src/mneme/ArtifactStore.js"
import * as InMemoryEventLogStore from "../../src/mneme/InMemoryEventLogStore.js"
import * as InMemoryPlanStore from "../../src/mneme/InMemoryPlanStore.js"
import { PlanExecution } from "../../src/orchestrator/PlanExecution.js"
import * as Planner from "../../src/orchestrator/Planner.js"
import { TrustLedger } from "../../src/policy/TrustLedger.js"
import { ToolRegistry } from "../../src/tools/ToolRegistry.js"

/**
 * The content endpoint against a store whose payload no longer matches its checksum.
 *
 * The in-memory and Postgres stores verify on read (ADR-007), so corruption reaches the API as a
 * failed `get` for an artifact `head` can still see. What this pins is the API's half: such an
 * artifact is a server error, its bytes are not served, and it is not reported as missing.
 */

const ID = "01890a5d-ac96-774b-bcce-b302099a8057" as ArtifactId

const corrupted = Layer.succeed(ArtifactStore, {
  put: () => Effect.die("unused"),
  head: () => Effect.succeed({ id: ID } as unknown as Artifact),
  get: (id) => Effect.fail(new ArtifactRetrieveError({ id, message: "checksum mismatch" })),
  delete: () => Effect.die("unused")
})

const { dispose, handler } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(
    ApiLive.pipe(
      Layer.provide(corrupted),
      Layer.provide(InMemoryEventLogStore.layer),
      Layer.provide(InMemoryPlanStore.layer),
      Layer.provide(Planner.layer),
      Layer.provide(Layer.succeed(ToolRegistry, {} as never)),
      Layer.provide(Layer.succeed(TrustLedger, {} as never)),
      Layer.provide(Layer.succeed(PlanExecution, { submit: () => Effect.die("unused") } as never))
    ),
    HttpServer.layerContext
  )
)

afterAll(() => dispose())

describe("an artifact whose payload fails its checksum", () => {
  it("is a server error, not a 404, and no bytes are served", async () => {
    const response = await handler(new Request(`http://local/artifacts/${ID}/content`))

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain("checksum mismatch")
  })
})
