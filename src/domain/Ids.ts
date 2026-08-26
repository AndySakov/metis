/**
 * UUIDv7 generation.
 *
 * Node has `randomUUID()` but it emits v4, which ADR-005 forbids — the whole reason for the
 * convention is that identifiers sort by creation time, and v4 is random throughout. So this
 * implements RFC 9562 §5.7 directly. It is the application-side counterpart to the `uuidv7()`
 * function in `migrations/0001_initial.sql`; both must produce identifiers the `uuid_v7` domain
 * accepts, which the tests check against real generated values rather than by inspection.
 */

import { randomBytes } from "node:crypto"

import type { EpochSeconds } from "./Common.js"

const HEX: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

/**
 * Layout: 48 bits of big-endian millisecond timestamp, 4 bits version (7), 12 bits random,
 * 2 bits variant (0b10), 62 bits random.
 *
 * `timestampMillis` is injectable so tests can pin ordering rather than racing the clock.
 */
export const uuidv7 = (timestampMillis: number = Date.now()): string => {
  const bytes = randomBytes(16)

  // 48-bit timestamp, most significant byte first.
  bytes[0] = (timestampMillis / 2 ** 40) & 0xff
  bytes[1] = (timestampMillis / 2 ** 32) & 0xff
  bytes[2] = (timestampMillis / 2 ** 24) & 0xff
  bytes[3] = (timestampMillis / 2 ** 16) & 0xff
  bytes[4] = (timestampMillis / 2 ** 8) & 0xff
  bytes[5] = timestampMillis & 0xff

  // Version 7 in the high nibble of byte 6; keep the low nibble's randomness.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  // Variant 0b10 in the top two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const h = (i: number): string => HEX[bytes[i]!]!

  return (
    h(0) + h(1) + h(2) + h(3) + "-" +
    h(4) + h(5) + "-" +
    h(6) + h(7) + "-" +
    h(8) + h(9) + "-" +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  )
}

/** The epoch-second timestamp embedded in a UUIDv7 — useful for auditing without a separate column. */
export const timestampOf = (id: string): EpochSeconds => {
  const millis = parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
  return Math.floor(millis / 1000) as EpochSeconds
}
