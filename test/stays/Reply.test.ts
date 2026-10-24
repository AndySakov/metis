import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { UnitProfile } from "../../src/domain/Stays.js"
import { draft, languageOf } from "../../src/stays/Reply.js"

/**
 * First replies to leads, against `specs/stays/conformance/replies.json`. The vectors hold whole
 * draft texts: the engine is deterministic, and a changed draft is a changed message to a guest.
 */

const SPEC = resolve(__dirname, "../../specs/stays/conformance")
const vectors = JSON.parse(readFileSync(resolve(SPEC, "replies.json"), "utf8")) as {
  profile: string
  listing: unknown
  cases: Array<{ name: string; lead: Record<string, unknown>; listing?: unknown; expect: unknown }>
}
const base = JSON.parse(readFileSync(resolve(SPEC, vectors.profile), "utf8"))

describe("reply conformance", () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const profile = Schema.decodeUnknownSync(UnitProfile)({ ...base, listing: vector.listing ?? vectors.listing })
      const lead = {
        verdict: "lead" as const,
        reason: "",
        direction: "seeking" as const,
        unit: "match" as const,
        areaTier: "accept" as const,
        datesStated: vector.lead.checkIn !== undefined,
        ...vector.lead
      } as any
      expect(draft(lead, profile)).toEqual(vector.expect)
    })
  }
})

describe("every draft", () => {
  it("opens with the listing and asks exactly one question, last", () => {
    for (const vector of vectors.cases) {
      const text = (vector.expect as { text: string }).text
      const lines = text.split("\n")
      expect(lines[0], vector.name).toMatch(/^(Hi|Habari)\b.*\b(have|Nina)\b/)
      expect(text.match(/\?/g)?.length, vector.name).toBe(1)
      expect(lines.at(-1)!.endsWith("?"), vector.name).toBe(true)
    }
  })
})

describe("the lead's language", () => {
  it("answers in the language the lead mostly uses", () => {
    expect(languageOf("Naomba 1 bedroom Westlands tarehe 15 mpaka 18")).toBe("sw")
    expect(languageOf("Nahitaji keja ya kulala usiku wa leo, budget 5k")).toBe("sw")
    expect(languageOf("Anyone with a 1br in Westlands for tonight?")).toBe("en")
    // One Swahili verb in an English sentence is still English.
    expect(languageOf("Client anataka one bedroom around Parklands, 3 nights from Friday")).toBe("en")
  })
})
