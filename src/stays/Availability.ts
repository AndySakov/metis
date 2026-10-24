/**
 * Availability for a short-let unit, read from its booking sheet: one tab per month, each opening
 * with a "Bookings" block.
 *
 * Two things about that sheet decide every answer, and both are easy to get wrong:
 *
 * - **A row's status is a cell colour, not a value.** The Confirmed cell's background says what the
 *   row is: green, a confirmed booking that blocks its nights; amber, a hot lead that may convert,
 *   held but still sellable to a firmer booking; red, an *open* slot the owner is carrying for
 *   projection, which is unsold inventory and the reason triage exists. Reading red rows as
 *   bookings makes an empty month look sold out. Paid is the fallback; a row with no colour at all
 *   (older tabs) is settled history, so confirmed.
 * - **The tabs disagree on date format** (MM/DD in some months, DD/MM in others). Every reading of
 *   a date pair is tried, and the sheet's own Number of Nights column picks the right one, with the
 *   tab's month as the tie-break. What stays ambiguous is reported, not guessed.
 *
 * Check-out day is not occupied: a booking from the 10th to the 13th holds the nights of the 10th,
 * 11th and 12th. Past the last month tab the sheet says nothing, which is not the same as free.
 *
 * Reads the Sheets API's `spreadsheets.get` response with grid data, as it comes. Free of Node APIs.
 */

type Day = string

export type Status = "confirmed" | "hot" | "open"

export interface Booking {
  readonly checkIn: Day
  readonly checkOut: Day
  readonly nights: number
  readonly channel: string
  readonly tab: string
  readonly status: Status
  readonly ambiguous: boolean
}

export interface Calendar {
  readonly bookings: ReadonlyArray<Booking>
  /** The last day the latest month tab covers. */
  readonly horizon?: Day
}

export type Verdict = "OPEN" | "FREE" | "CONTESTED" | "BOOKED" | "NO DATA"

export interface Answer {
  readonly verdict: Verdict
  readonly detail: string
  /** The next window of the same length, when the dates asked for are taken. */
  readonly nextWindow?: { readonly checkIn: Day; readonly checkOut: Day }
}

/** The part of a Sheets `spreadsheets.get` response with `includeGridData` that this reads. */
export interface SheetSnapshot {
  readonly sheets?: ReadonlyArray<{
    readonly properties?: { readonly title?: string }
    readonly data?: ReadonlyArray<{
      readonly rowData?: ReadonlyArray<{
        readonly values?: ReadonlyArray<{
          readonly formattedValue?: string
          readonly effectiveFormat?: { readonly backgroundColor?: Rgb }
        }>
      }>
    }>
  }>
}

interface Rgb {
  readonly red?: number
  readonly green?: number
  readonly blue?: number
}

// ---- Days --------------------------------------------------------------------------------------

const asDay = (y: number, m: number, d: number): Day | undefined => {
  // A day-first cell read month-first asks for month 17: no such date, not an exception.
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return undefined
  const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day ? day : undefined
}
const addDays = (day: Day, n: number): Day => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const between = (from: Day, to: Day): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
const short = (day: Day): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
]

/** `"August 2026"` → `[8, 2026]`. */
const tabMonth = (tab: string): [number, number] | undefined => {
  const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(tab.trim())
  const month = match === null ? -1 : MONTHS.indexOf(match[1]!.toLowerCase())
  return month < 0 ? undefined : [month + 1, Number(match![2])]
}

/** The last day of a tab's month: the day before the first of the next. */
const lastDayOf = ([month, year]: [number, number]): Day =>
  addDays(month === 12 ? asDay(year + 1, 1, 1)! : asDay(year, month + 1, 1)!, -1)

/** Every date a `d/m/y`-ish cell could mean: month-first, then day-first. */
const readings = (cell: string): Array<Day> => {
  const parts = cell.trim().split(/[/.-]/)
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return []
  const [a, b, rawYear] = parts.map(Number) as [number, number, number]
  const year = rawYear < 100 ? rawYear + 2000 : rawYear
  return [...new Set([asDay(year, a, b), asDay(year, b, a)].filter((d): d is Day => d !== undefined))]
}

// ---- Colours -----------------------------------------------------------------------------------

const COLOURS: ReadonlyArray<[Status, number, number, number]> = [
  ["confirmed", 0.204, 0.659, 0.325], // #34A853 green
  ["hot", 0.984, 0.737, 0.016], // #FBBC04 amber
  ["open", 0.918, 0.263, 0.208] // #EA4335 red
]

/**
 * The status a cell's background encodes, or undefined for white or none. Nearest within a
 * tolerance rather than exact: Sheets returns slightly different floats depending on how a colour
 * was applied, and shades get re-picked by hand.
 */
export const statusOf = (rgb: Rgb | undefined, tolerance = 0.12): Status | undefined => {
  if (rgb === undefined) return undefined
  const r = rgb.red ?? 0
  const g = rgb.green ?? 0
  const b = rgb.blue ?? 0
  if (r > 0.9 && g > 0.9 && b > 0.9) return undefined
  let best: Status | undefined
  let distance = tolerance
  for (const [status, cr, cg, cb] of COLOURS) {
    const d = Math.max(Math.abs(r - cr), Math.abs(g - cg), Math.abs(b - cb))
    if (d < distance) [best, distance] = [status, d]
  }
  return best
}

// ---- Reading the sheet -------------------------------------------------------------------------

const toInt = (cell: string | undefined): number | undefined => {
  const n = Number((cell ?? "").replace(/,/g, "").trim())
  return cell === undefined || cell.trim() === "" || Number.isNaN(n) ? undefined : Math.round(n)
}

/** One booking row, its dates pinned down by the stated night count where they could read two ways. */
const bookingFrom = (
  cells: { checkIn: string; checkOut: string; nights?: string; channel?: string },
  tab: string,
  status: Status
): Booking | undefined => {
  const stated = toInt(cells.nights)
  const month = tabMonth(tab)
  const scored = readings(cells.checkIn).flatMap((checkIn) =>
    readings(cells.checkOut).flatMap((checkOut) => {
      const nights = between(checkIn, checkOut)
      if (nights <= 0 || nights > 90) return []
      const nightsMatch = stated !== undefined && nights === stated
      const inTabMonth = month !== undefined && Number(checkOut.slice(5, 7)) === month[0] &&
        Number(checkOut.slice(0, 4)) === month[1]
      return [{ rank: (nightsMatch ? 0 : 2) + (inTabMonth ? 0 : 1), checkIn, checkOut, nights }]
    })
  ).sort((x, y) => x.rank - y.rank)
  const best = scored[0]
  if (best === undefined) return undefined
  return {
    checkIn: best.checkIn,
    checkOut: best.checkOut,
    nights: best.nights,
    channel: (cells.channel ?? "").trim(),
    tab,
    status,
    ambiguous: scored.length > 1 && scored[1]!.rank === best.rank
  }
}

/**
 * Every booking row in every month tab. Within a tab, the block after a "Bookings" heading is read
 * by its header row's column names, so a column moving does not misread the sheet.
 */
export const calendarFrom = (snapshot: SheetSnapshot): Calendar => {
  const bookings: Array<Booking> = []
  const ends: Array<Day> = []
  for (const sheet of snapshot.sheets ?? []) {
    const tab = sheet.properties?.title ?? ""
    const month = tabMonth(tab)
    if (month === undefined) continue
    ends.push(lastDayOf(month))

    const rows = (sheet.data ?? []).flatMap((block) => block.rowData ?? [])
    let columns: Record<string, number> | undefined
    let inBlock = false
    for (const row of rows) {
      const cells = row.values ?? []
      const text = cells.map((cell) => (cell.formattedValue ?? "").trim())
      const head = (text[0] ?? "").toLowerCase()
      if (text.every((t) => t === "")) {
        inBlock = false
        continue
      }
      if (head === "bookings") {
        inBlock = true
        continue
      }
      if (head === "check in date") {
        columns = Object.fromEntries(text.map((name, i) => [name.toLowerCase(), i]))
        continue
      }
      if (head === "total" || head === "expenditure") {
        inBlock = false
        continue
      }
      if (!inBlock || columns === undefined) continue

      const at = (name: string) => columns![name]
      const colour = (name: string) => {
        const i = at(name)
        return i === undefined ? undefined : statusOf(cells[i]?.effectiveFormat?.backgroundColor)
      }
      const status = colour("confirmed") ?? colour("paid") ?? "confirmed"
      const booking = bookingFrom(
        {
          checkIn: text[at("check in date") ?? 0] ?? "",
          checkOut: text[at("check out date") ?? 1] ?? "",
          ...(at("number of nights") !== undefined ? { nights: text[at("number of nights")!] } : {}),
          ...(at("channel") !== undefined ? { channel: text[at("channel")!] } : {})
        },
        tab,
        status
      )
      if (booking !== undefined) bookings.push(booking)
    }
  }
  const horizon = ends.sort().at(-1)
  return { bookings, ...(horizon !== undefined ? { horizon } : {}) }
}

// ---- Answering ---------------------------------------------------------------------------------

const overlapping = (calendar: Calendar, checkIn: Day, checkOut: Day, status: Status) =>
  calendar.bookings.filter((b) => b.status === status && b.checkIn < checkOut && checkIn < b.checkOut)

/** Nights genuinely off the market: confirmed and hot. Open slots are inventory. */
const occupied = (calendar: Calendar): Set<Day> => {
  const nights = new Set<Day>()
  for (const b of calendar.bookings) {
    if (b.status === "open") continue
    for (let i = 0; i < b.nights; i++) nights.add(addDays(b.checkIn, i))
  }
  return nights
}

/** The first run of `nights` free nights starting on or after `from`, within four months. */
const nextFree = (calendar: Calendar, from: Day, nights: number): Answer["nextWindow"] => {
  const taken = occupied(calendar)
  let run = 0
  for (let i = 0; i < 120; i++) {
    const day = addDays(from, i)
    if (calendar.horizon !== undefined && day > calendar.horizon) return undefined
    run = taken.has(day) ? 0 : run + 1
    if (run === nights) return { checkIn: addDays(day, 1 - nights), checkOut: addDays(day, 1) }
  }
  return undefined
}

/** Whether the unit can take a stay from `checkIn` to `checkOut`, and if not, when it could. */
export const answer = (calendar: Calendar, checkIn: Day, checkOut: Day): Answer => {
  const nights = between(checkIn, checkOut)
  const span = `${short(checkIn)} to ${short(checkOut)} (${nights} night${nights === 1 ? "" : "s"})`
  if (nights <= 0) return { verdict: "NO DATA", detail: "check-out is not after check-in" }

  const firm = overlapping(calendar, checkIn, checkOut, "confirmed")
  if (firm.length > 0) {
    const next = nextFree(calendar, checkOut, nights)
    return {
      verdict: "BOOKED",
      detail: `clashes with ${
        firm.map((b) => `${short(b.checkIn)}-${short(b.checkOut)} (${b.channel || "unknown"})`).join(", ")
      }`,
      ...(next !== undefined ? { nextWindow: next } : {})
    }
  }
  const hot = overlapping(calendar, checkIn, checkOut, "hot")
  if (hot.length > 0) {
    return {
      verdict: "CONTESTED",
      detail: `${span} overlaps a hot lead (${
        hot.map((b) => `${short(b.checkIn)}-${short(b.checkOut)}`).join(", ")
      }) that has not converted: sellable if this one is firmer`
    }
  }
  if (overlapping(calendar, checkIn, checkOut, "open").length > 0) {
    return { verdict: "OPEN", detail: `${span} is an unsold slot carried for projection: fill it` }
  }
  if (calendar.horizon !== undefined && checkOut > addDays(calendar.horizon, 1)) {
    return {
      verdict: "NO DATA",
      detail: `${span} is past the last month in the sheet: add that month's tab before promising it`
    }
  }
  return { verdict: "FREE", detail: `${span} is free` }
}
