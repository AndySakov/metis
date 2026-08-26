import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { Uuid7 } from "../../src/domain/Common.js"
import { timestampOf, uuidv7 } from "../../src/domain/Ids.js"

const decode = Schema.decodeUnknownSync(Uuid7)

describe("uuidv7", () => {
  it("produces identifiers the domain schema accepts", () => {
    for (let i = 0; i < 500; i++) {
      expect(() => decode(uuidv7())).not.toThrow()
    }
  })

  it("is never a UUIDv4", () => {
    // The version nibble is the whole point; a regression here silently reintroduces the bug
    // ADR-005 exists to prevent, and nothing else in the system would notice for a long time.
    for (let i = 0; i < 500; i++) {
      expect(uuidv7()[14], "version nibble").toBe("7")
      expect("89ab", "variant nibble").toContain(uuidv7()[19])
    }
  })

  it("sorts lexicographically by creation time", () => {
    const ids = [1, 2, 3, 4, 5].map((n) => uuidv7(1_700_000_000_000 + n * 1000))
    expect([...ids].sort()).toEqual(ids)
  })

  it("sorts correctly across a byte boundary in the timestamp", () => {
    // 0x...FF -> 0x...00 + carry. A naive little-endian write passes the previous test and fails
    // this one.
    const before = uuidv7(0x0000_00ff_ffff)
    const after = uuidv7(0x0000_0100_0000)
    expect(before < after).toBe(true)
  })

  it("round-trips its embedded timestamp", () => {
    const id = uuidv7(1_700_000_123_456)
    expect(timestampOf(id)).toBe(1_700_000_123)
  })

  it("is unique across many draws at the same millisecond", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(1_700_000_000_000)))
    expect(ids.size).toBe(5000)
  })
})
