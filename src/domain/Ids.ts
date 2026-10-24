/**
 * UUIDv7 generation.
 *
 * Node has `randomUUID()` but it emits v4, which ADR-005 forbids — the whole reason for the
 * convention is that identifiers sort by creation time, and v4 is random throughout. So this
 * implements RFC 9562 §5.7 directly. It is the application-side counterpart to the `uuidv7()`
 * function in `migrations/0001_initial.sql`; both must produce identifiers the `uuid_v7` domain
 * accepts, which the tests check against real generated values rather than by inspection.
 */

import { randomBytes, randomInt } from "node:crypto"

import type { EpochSeconds } from "./Common.js"

const HEX: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

/** The millisecond last encoded, and the counter within it (RFC 9562 §6.2, method 1). */
const last = { millis: -1, counter: 0 }

/**
 * Layout: 48 bits of big-endian millisecond timestamp, 4 bits version (7), a 12-bit counter,
 * 2 bits variant (0b10), 62 bits random.
 *
 * The counter is what makes identifiers made in the same millisecond sort in the order they were
 * made. The event log orders by time and then by id, so without it two events written in one
 * millisecond (an approval and the dispatch it allowed) could read back in either order. It starts
 * at a random value below 2048 each new millisecond and counts up; past 4095 in one millisecond the
 * timestamp moves on by one, as the RFC allows.
 *
 * `timestampMillis` is injectable so tests can pin ordering rather than racing the clock. A
 * timestamp more than a millisecond behind the last is encoded as given.
 */
export const uuidv7 = (timestampMillis: number = Date.now()): string => {
  const bytes = randomBytes(16)

  if (timestampMillis > last.millis || timestampMillis < last.millis - 1) {
    last.millis = timestampMillis
    last.counter = randomInt(0, 0x800)
  } else {
    // The same millisecond, or one behind it (the counter overflowed into the next): keep order.
    last.counter++
    if (last.counter > 0xfff) {
      last.millis++
      last.counter = 0
    }
  }
  const millis = last.millis

  // 48-bit timestamp, most significant byte first.
  bytes[0] = (millis / 2 ** 40) & 0xff
  bytes[1] = (millis / 2 ** 32) & 0xff
  bytes[2] = (millis / 2 ** 24) & 0xff
  bytes[3] = (millis / 2 ** 16) & 0xff
  bytes[4] = (millis / 2 ** 8) & 0xff
  bytes[5] = millis & 0xff

  // Version 7 in the high nibble of byte 6, then the counter across the rest of bytes 6 and 7.
  bytes[6] = 0x70 | (last.counter >> 8)
  bytes[7] = last.counter & 0xff
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
