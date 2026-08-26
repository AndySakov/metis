import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import * as InMemoryArtifactStore from "../../src/mneme/InMemoryArtifactStore.js"
import * as InMemoryEventLogStore from "../../src/mneme/InMemoryEventLogStore.js"
import { loadVectors, runArtifactVector, runEventLogVector } from "./Conformance.js"

/**
 * The conformance vectors, executed. ADR-007 requires adapters to pass them; this is the harness
 * that makes "must pass" mean something for the in-memory adapter. The Postgres adapter runs the
 * identical vectors in `PostgresStores.test.ts`.
 */

describe("InMemoryEventLogStore passes its conformance vectors", () => {
  const vectors = loadVectors("eventlog")

  it("there are vectors to run", () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const vector of vectors) {
    it(vector.name, async () => {
      // A fresh store per vector: vectors assert on the whole log, so they must not see each
      // other's events.
      await Effect.runPromise(
        runEventLogVector(vector).pipe(Effect.provide(InMemoryEventLogStore.layer)) as Effect.Effect<void>
      )
    })
  }
})

describe("InMemoryArtifactStore passes its conformance vectors", () => {
  const vectors = loadVectors("artifact")

  it("there are vectors to run", () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const vector of vectors) {
    it(vector.name, async () => {
      await Effect.runPromise(
        runArtifactVector(vector).pipe(Effect.provide(InMemoryArtifactStore.layer)) as Effect.Effect<void>
      )
    })
  }
})
