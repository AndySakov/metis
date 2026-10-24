import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ToolSpec } from "../../src/domain/ToolSpec.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/** `stays.triage` over real MCP: the paste goes in, the leads come out, against a unit profile. */

const spec = Schema.decodeUnknownSync(ToolSpec)(
  JSON.parse(readFileSync(resolve(__dirname, "../../specs/tools/examples/stays.triage.tool.json"), "utf8"))
)
const dir = mkdtempSync(join(tmpdir(), "metis-stays-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const call = (input: Record<string, unknown>, env?: Record<string, string>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const runner = yield* ToolRunner
        return yield* Effect.either(runner.run(spec, input))
      })
    ).pipe(
      Effect.provide(McpToolRunner.layer({
        "metis.stays": {
          command: "node",
          args: ["--experimental-strip-types", resolve(__dirname, "../../src/tools/servers/stays.ts")],
          ...(env !== undefined ? { env } : {})
        }
      }))
    ) as Effect.Effect<any>
  )

const CHAT = [
  "[10/08/2026, 01:12:33] Wanjiru: Nahitaji keja ya one bedroom Westlands usiku wa leo",
  "[10/08/2026, 01:20:10] Host: 1 BEDROOM WESTLANDS ✅ Ksh7000/night 📞 0712345678",
  "[10/08/2026, 07:45:02] Brian: Any bnb 2 bedroom Kilimani this weekend?"
].join("\n")

describe("stays.triage", () => {
  it("finds the lead in a pasted export, against the example Westlands 1-bed", async () => {
    const outcome = await call({ messages: CHAT, group: "Nairobi Spaces", now: "2026-08-10T09:00:00+03:00" })
    expect(outcome._tag).toBe("Right")
    const { markdown, results, unit } = outcome.right.output
    expect(unit).toBe("Westlands 1-bed")
    expect(results.map((r: any) => [r.sender, r.verdict])).toEqual([
      ["Wanjiru", "lead"],
      ["Host", "noise"],
      ["Brian", "noise"]
    ])
    expect(results[0]).toMatchObject({ group: "Nairobi Spaces", checkIn: "2026-08-10", confidence: "high" })
    expect(markdown).toContain("## Leads for Westlands 1-bed (1)")
  }, 30_000)

  it("judges against the owner's own profile when one is configured", async () => {
    // A two-bedroom in Kilimani: Brian's request is now the lead, and Wanjiru's is still in range.
    const profile = JSON.parse(
      readFileSync(resolve(__dirname, "../../specs/stays/units/example-westlands-1br.json"), "utf8")
    )
    writeFileSync(
      join(dir, "kilimani-2br.json"),
      JSON.stringify({ ...profile, id: "kilimani-2br", name: "Kilimani 2-bed", bedrooms: 2 })
    )
    const outcome = await call(
      { messages: CHAT, now: "2026-08-10T09:00:00+03:00" },
      { METIS_STAYS_PROFILE: join(dir, "kilimani-2br.json") }
    )
    expect(outcome.right.output.results.map((r: any) => r.verdict)).toEqual(["lead", "noise", "lead"])
  }, 30_000)

  it("will not run against a malformed profile", async () => {
    writeFileSync(
      join(dir, "broken.json"),
      JSON.stringify({ id: "x", name: "X", timezone: "Mars/Olympus", bedrooms: 1, areas: {} })
    )
    const outcome = await call({ messages: CHAT }, { METIS_STAYS_PROFILE: join(dir, "broken.json") })
    expect(outcome._tag).toBe("Left")
  }, 30_000)
})
