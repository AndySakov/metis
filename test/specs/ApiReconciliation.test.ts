import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { parse } from "yaml"

import { IntentApi } from "../../src/ingress/IntentApi.js"

/**
 * ADR-011: "The OpenAPI spec and the `HttpApi` definition can diverge. One must generate or
 * validate the other in CI — this is now a required check, not a convention."
 *
 * This is that check. `specs/api/openapi.yaml` is canonical (ADR-004), so it is the side that
 * wins: an endpoint marked `x-status: implemented` must exist in the code, and an endpoint in the
 * code must appear in the spec. Endpoints the spec has agreed but nobody has built are marked
 * `x-status: planned` — declared, rather than quietly omitted so the file reads as complete.
 */

const SPECS = resolve(__dirname, "../../specs")

const openapi = parse(readFileSync(join(SPECS, "api/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string; "x-status"?: string }>>
}

const asyncapi = parse(readFileSync(join(SPECS, "events/asyncapi.yaml"), "utf8")) as {
  channels: Record<string, unknown>
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"]

interface SpecOperation {
  readonly path: string
  readonly method: string
  readonly operationId: string
  readonly status: string
}

const specOperations: Array<SpecOperation> = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => HTTP_METHODS.includes(method))
    .map(([method, operation]) => ({
      path,
      method,
      operationId: operation.operationId ?? "",
      status: operation["x-status"] ?? ""
    }))
)

/**
 * Endpoints actually declared by the Effect `HttpApi`.
 *
 * Paths come back in `:param` form; OpenAPI writes `{param}`, so one side is normalised.
 */
interface CodeEndpoint {
  readonly name: string
  readonly path: string
  readonly method: string
}

const codeOperations = Object.values(
  IntentApi.groups as unknown as Record<string, { endpoints: Record<string, CodeEndpoint> }>
).flatMap((group) =>
  Object.values(group.endpoints).map((endpoint) => ({
    operationId: endpoint.name,
    path: endpoint.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
    method: endpoint.method.toLowerCase()
  }))
)

describe("openapi.yaml and the HttpApi definition agree (ADR-011)", () => {
  it("the spec declares an x-status for every operation", () => {
    const missing = specOperations.filter((op) => op.status !== "implemented" && op.status !== "planned")
    expect(missing.map((op) => `${op.method.toUpperCase()} ${op.path}`)).toEqual([])
  })

  it("every operation has a unique operationId", () => {
    const ids = specOperations.map((op) => op.operationId)
    expect(ids).not.toContain("")
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("the code declares at least one endpoint", () => {
    expect(codeOperations.length).toBeGreaterThan(0)
  })

  it("every endpoint in the code appears in the spec, with the same path and method", () => {
    const specKeys = new Set(specOperations.map((op) => `${op.method} ${op.path}`))
    const undeclared = codeOperations
      .map((op) => `${op.method} ${op.path}`)
      .filter((key) => !specKeys.has(key))

    expect(undeclared).toEqual([])
  })

  it("every operation marked `implemented` exists in the code", () => {
    const codeKeys = new Set(codeOperations.map((op) => `${op.method} ${op.path}`))
    const claimed = specOperations
      .filter((op) => op.status === "implemented")
      .map((op) => `${op.method} ${op.path}`)
      .filter((key) => !codeKeys.has(key))

    expect(claimed).toEqual([])
  })

  it("operationIds match between spec and code for implemented endpoints", () => {
    const byKey = new Map(specOperations.map((op) => [`${op.method} ${op.path}`, op]))
    const mismatched = codeOperations
      .map((op) => {
        const spec = byKey.get(`${op.method} ${op.path}`)
        return spec !== undefined && spec.operationId !== op.operationId
          ? `${op.method} ${op.path}: code=${op.operationId} spec=${spec.operationId}`
          : null
      })
      .filter((entry): entry is string => entry !== null)

    expect(mismatched).toEqual([])
  })
})

describe("API specs reference schemas that exist", () => {
  const collectRefs = (node: unknown, acc: Array<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) collectRefs(item, acc)
      return
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") acc.push(value)
        else collectRefs(value, acc)
      }
    }
  }

  const cases = [
    { name: "openapi.yaml", dir: join(SPECS, "api"), doc: openapi as unknown },
    { name: "asyncapi.yaml", dir: join(SPECS, "events"), doc: asyncapi as unknown }
  ]

  for (const { dir, doc, name } of cases) {
    it(`${name}: every external $ref resolves`, () => {
      const refs: Array<string> = []
      collectRefs(doc, refs)

      const broken = refs
        .filter((ref) => !ref.startsWith("#"))
        .filter((ref) => !existsSync(resolve(dir, ref.split("#")[0]!)))

      expect(broken).toEqual([])
    })
  }

  it("openapi.yaml: every internal #/components pointer resolves", () => {
    const refs: Array<string> = []
    collectRefs(openapi, refs)

    const document = openapi as unknown as Record<string, unknown>
    const broken = refs
      .filter((ref) => ref.startsWith("#/"))
      .filter((ref) => {
        let cursor: unknown = document
        for (const segment of ref.slice(2).split("/")) {
          if (cursor === null || typeof cursor !== "object") return true
          cursor = (cursor as Record<string, unknown>)[segment]
        }
        return cursor === undefined
      })

    expect(broken).toEqual([])
  })
})

describe("conformance vectors describe stores that still exist (ADR-013)", () => {
  const root = join(SPECS, "storage/conformance")

  it("no vectors remain for the dropped GraphStore or VectorIndex", () => {
    const suites = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    expect(suites).not.toContain("graph")
    expect(suites).not.toContain("vector")
    expect(suites).toEqual(["artifact", "eventlog"])
  })

  it("every vector names the interface it exercises", () => {
    const named = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((dir) =>
        readdirSync(join(root, dir.name))
          .filter((file) => file.endsWith(".json"))
          .map((file) => join(root, dir.name, file))
      )
      .map((file) => JSON.parse(readFileSync(file, "utf8")) as { interface?: string; name?: string })

    expect(named.length).toBeGreaterThan(0)
    for (const vector of named) {
      expect(["EventLogStore", "ArtifactStore"]).toContain(vector.interface)
    }
  })
})
