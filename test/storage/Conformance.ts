/**
 * Runs the JSON conformance vectors in `specs/storage/conformance/` against a live adapter.
 *
 * ADR-007 says adapters must pass these vectors; until now nothing executed them, which made the
 * requirement a statement of intent. The point of driving them from the spec files rather than
 * hand-writing equivalent assertions is that the vectors stay the contract: an adapter in another
 * language (ADR-015 permits one at a contract boundary) can be held to the identical file.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { Artifact } from "../../src/domain/Artifact.js"
import { Event } from "../../src/domain/Event.js"
import { ArtifactStore } from "../../src/mneme/ArtifactStore.js"
import { EventLogStore } from "../../src/mneme/EventLogStore.js"
import { checksumOf } from "../../src/mneme/InMemoryArtifactStore.js"

const CONFORMANCE = resolve(__dirname, "../../specs/storage/conformance")

export interface Vector {
  readonly name: string
  readonly interface: string
  readonly steps: ReadonlyArray<Record<string, any>>
}

export const loadVectors = (suite: string): Array<Vector> => {
  const dir = join(CONFORMANCE, suite)
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Vector)
}

const decodeEvent = Schema.decodeUnknownSync(Event)
const decodeArtifact = Schema.decodeUnknownSync(Artifact)

/** Runs one EventLogStore vector against whatever adapter is in context. */
export const runEventLogVector = (vector: Vector): Effect.Effect<void, unknown, EventLogStore> =>
  Effect.gen(function*() {
    const store = yield* EventLogStore

    for (const step of vector.steps) {
      switch (step.op) {
        case "append": {
          yield* store.append(decodeEvent(step.event))
          break
        }
        case "read": {
          const found = yield* store.read(step.query ?? {})
          const expected = step.expect ?? {}

          if (expected.count !== undefined) {
            expect(found.length, `${vector.name}: count`).toBe(expected.count)
          }
          if (expected.uniqueIds === true) {
            expect(new Set(found.map((e) => e.id)).size, `${vector.name}: uniqueIds`).toBe(found.length)
          }
          if (expected.firstWriteWins !== undefined) {
            const record = found.find((e) => e.id === expected.firstWriteWins.id)
            expect(record, `${vector.name}: firstWriteWins record present`).toBeDefined()
            expect(record!.ts, `${vector.name}: firstWriteWins ts`).toBe(expected.firstWriteWins.ts)
          }
          if (expected.idsInOrder !== undefined) {
            expect(found.map((e) => e.id), `${vector.name}: idsInOrder`).toEqual(expected.idsInOrder)
          }
          break
        }
        default:
          throw new Error(`${vector.name}: unknown op ${String(step.op)}`)
      }
    }
  })

/** Runs one ArtifactStore vector against whatever adapter is in context. */
export const runArtifactVector = (vector: Vector): Effect.Effect<void, unknown, ArtifactStore> =>
  Effect.gen(function*() {
    const store = yield* ArtifactStore

    for (const step of vector.steps) {
      const expected = step.expect ?? {}
      // A step declaring `expect.error` asserts the operation fails with that tagged error —
      // the vectors cover rejection paths, not just happy ones.
      const expectsError: string | undefined = expected.error

      switch (step.op) {
        case "put": {
          const payload = new TextEncoder().encode(step.payloadUtf8 ?? "")
          const outcome = yield* Effect.either(store.put(decodeArtifact(step.artifact), payload))
          if (expectsError !== undefined) {
            expect(outcome._tag, `${vector.name}: put should fail`).toBe("Left")
            expect((outcome as any).left._tag, `${vector.name}: put error tag`).toBe(expectsError)
          } else {
            expect(outcome._tag, `${vector.name}: put should succeed`).toBe("Right")
          }
          break
        }
        case "head": {
          const outcome = yield* Effect.either(store.head(step.id))
          if (expectsError !== undefined) {
            expect(outcome._tag, `${vector.name}: head should fail`).toBe("Left")
            expect((outcome as any).left._tag, `${vector.name}: head error tag`).toBe(expectsError)
            break
          }
          expect(outcome._tag, `${vector.name}: head should succeed`).toBe("Right")
          const metadata = (outcome as any).right as Artifact

          if (expected.returnsMetadataOnly === true) {
            expect(Object.keys(metadata), `${vector.name}: head returns no payload`).not.toContain("payload")
          }
          if (expected.checksum !== undefined) {
            expect(metadata.checksum, `${vector.name}: head checksum`).toBe(expected.checksum)
          }
          if (expected.provenanceCount !== undefined) {
            expect(metadata.provenance.length, `${vector.name}: provenanceCount`).toBe(expected.provenanceCount)
          }
          break
        }
        case "get": {
          const outcome = yield* Effect.either(store.get(step.id))
          if (expectsError !== undefined) {
            expect(outcome._tag, `${vector.name}: get should fail`).toBe("Left")
            expect((outcome as any).left._tag, `${vector.name}: get error tag`).toBe(expectsError)
            break
          }
          expect(outcome._tag, `${vector.name}: get should succeed`).toBe("Right")
          const { metadata, payload } = (outcome as any).right as { metadata: Artifact; payload: Uint8Array }

          if (expected.payloadUtf8 !== undefined) {
            expect(new TextDecoder().decode(payload), `${vector.name}: payload`).toBe(expected.payloadUtf8)
          }
          if (expected.checksumVerified === true) {
            expect(checksumOf(payload), `${vector.name}: checksum matches payload`).toBe(metadata.checksum)
          }
          break
        }
        default:
          throw new Error(`${vector.name}: unknown op ${String(step.op)}`)
      }
    }
  })
