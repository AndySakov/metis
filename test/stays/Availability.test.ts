import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"

import { answer, calendarFrom, statusOf } from "../../src/stays/Availability.js"

/** Availability against its conformance vectors (`specs/stays/conformance/availability.json`). */

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../../specs/stays/conformance/availability.json"), "utf8")
) as {
  snapshot: any
  cases: Array<{ name: string; checkIn: string; checkOut: string; expect: Record<string, unknown> }>
}

const calendar = calendarFrom(vectors.snapshot)

describe("availability conformance", () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const result = answer(calendar, vector.checkIn, vector.checkOut)
      const actual = Object.fromEntries(Object.keys(vector.expect).map((key) => [key, (result as any)[key]]))
      expect(actual, result.detail).toEqual(vector.expect)
    })
  }
})

describe("reading the sheet", () => {
  it("reads every booking row, and only booking rows, with the status its colour gives", () => {
    expect(calendar.bookings.map((b) => [b.checkIn, b.checkOut, b.status])).toEqual([
      ["2026-05-17", "2026-05-20", "confirmed"],
      ["2026-06-04", "2026-06-07", "confirmed"],
      ["2026-07-31", "2026-08-02", "confirmed"],
      ["2026-08-10", "2026-08-13", "open"],
      ["2026-08-15", "2026-08-18", "hot"],
      ["2026-08-20", "2026-08-25", "confirmed"]
    ])
    expect(calendar.horizon).toBe("2026-08-31")
    expect(calendar.bookings.some((b) => b.ambiguous)).toBe(false)
  })

  it("matches a colour within a tolerance, and treats white as no status", () => {
    expect(statusOf({ red: 0.21, green: 0.66, blue: 0.33 })).toBe("confirmed")
    expect(statusOf({ red: 0.95, green: 0.27, blue: 0.2 })).toBe("open")
    expect(statusOf({ red: 1, green: 1, blue: 1 })).toBeUndefined()
    expect(statusOf({ red: 0.5, green: 0.5, blue: 0.9 })).toBeUndefined()
  })
})
