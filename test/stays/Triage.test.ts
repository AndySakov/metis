import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { UnitProfile } from "../../src/domain/Stays.js"
import { parseChat, report, triage } from "../../src/stays/Triage.js"

/**
 * Lead triage against its conformance vectors (`specs/stays/conformance/triage.json`): the owner's
 * worked examples verbatim, then the rules behind them. A vector that changes verdict is a
 * behaviour change to discuss, not a test to update.
 */

const SPEC = resolve(__dirname, "../../specs/stays/conformance")
const vectors = JSON.parse(readFileSync(resolve(SPEC, "triage.json"), "utf8")) as {
  profile: string
  now: string
  cases: Array<{ name: string; message: string; now?: string; expect: Record<string, string> }>
}
const profile = Schema.decodeUnknownSync(UnitProfile)(JSON.parse(readFileSync(resolve(SPEC, vectors.profile), "utf8")))

describe("lead triage conformance", () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const result = triage({ text: vector.message }, profile, new Date(vector.now ?? vectors.now))
      const actual = Object.fromEntries(Object.keys(vector.expect).map((key) => [key, (result as any)[key]]))
      expect(actual, `${vector.message} → ${result.reason}`).toEqual(vector.expect)
    })
  }
})

describe("pasted chats", () => {
  it("reads iOS and Android exports, keeping continuation lines with their message", () => {
    const ios = parseChat(
      "[10/08/2026, 01:12:33] Wanjiru: Nahitaji keja ya one bedroom\nWestlands usiku wa leo\n" +
        "[10/08/2026, 01:13:02] Host: <Media omitted>",
      "Nairobi Spaces"
    )
    expect(ios).toEqual([{
      at: "10/08/2026, 01:12:33",
      sender: "Wanjiru",
      text: "Nahitaji keja ya one bedroom\nWestlands usiku wa leo",
      group: "Nairobi Spaces"
    }])

    const android = parseChat(
      "10/08/2026, 13:05 - Kevin: Anyone with a 1br in Kilimani?\n10/08/2026, 13:06 - Agent: Available!"
    )
    expect(android.map((m) => m.sender)).toEqual(["Kevin", "Agent"])
  })

  it("splits text in no export format on blank lines", () => {
    expect(parseChat("first message\n\nsecond\nstill second").map((m) => m.text)).toEqual([
      "first message",
      "second\nstill second"
    ])
  })
})

describe("the report", () => {
  it("puts leads first, best first, and noise as counts", () => {
    const now = new Date("2026-08-10T09:00:00+03:00")
    const triaged = [
      "1 BEDROOM WESTLANDS ✅ Ksh7000/night",
      "Looking for a studio in Kilimani 2 nights from tomorrow",
      "Anyone with a 1br in Westlands for tonight?",
      "Any bnb 2 bedroom Kilimani this weekend?"
    ].map((text) => triage({ text }, profile, now))
    const markdown = report(triaged, profile)

    expect(markdown).toContain("## Leads for Westlands 1-bed (2)")
    expect(markdown.indexOf("Westlands for tonight")).toBeLessThan(markdown.indexOf("studio in Kilimani"))
    expect(markdown).toContain("**1. 2026-08-10 to 2026-08-11, high confidence**")
    expect(markdown).toContain("4 messages: 2 leads, 2 noise.")
    expect(markdown).toContain("- advertising, not seeking: 1")
    expect(markdown).toContain("Reply with the listing")
  })
})
