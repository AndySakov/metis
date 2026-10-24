import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ToolSpec } from "../../src/domain/ToolSpec.js"
import * as ToolRegistry from "../../src/tools/ToolRegistry.js"

const example = JSON.parse(
  readFileSync(resolve(__dirname, "../../specs/tools/examples/design.prd.tool.json"), "utf8")
) as Record<string, unknown>

const claiming = (isolation: string) => Schema.decodeUnknownSync(ToolSpec)({ ...example, isolation })

describe("the registry refuses isolation that does not exist yet (ADR-020)", () => {
  for (const tier of ["container", "wasm"]) {
    it(`rejects a descriptor claiming ${tier}`, async () => {
      expect(ToolRegistry.validationErrors(claiming(tier)).join("\n")).toContain(tier)
      const built = await Effect.runPromise(Effect.either(ToolRegistry.make([claiming(tier)])))
      expect(built._tag).toBe("Left")
    })
  }

  for (const tier of ["none", "process"]) {
    it(`accepts a descriptor declaring ${tier}`, () => {
      expect(ToolRegistry.validationErrors(claiming(tier))).toEqual([])
    })
  }
})
