/**
 * Lead triage for a short-let: which messages in a pasted group chat are people looking for a place
 * to stay that this unit could fill, and when.
 *
 * Deterministic on purpose. The groups it reads are ~99% hosts advertising, the cost of a missed
 * lead is a booking, and the cost of a false one is a wasted glance, so the rules below are the
 * ones learned from sweeping them, written as code that conformance vectors can hold still:
 *
 * 1. **Direction before anything else.** A perfect advert for the right unit is still noise. Verbs
 *    of seeking win over a number; a phone number, a nightly price or a rate card mean supply.
 * 2. **What is sought must be a place to stay.** The same groups trade cars and cleaners.
 * 3. **Unit.** The unit's bedroom count or unstated matches; a studio or bedsitter is a weak match;
 *    more bedrooms is not.
 * 4. **Location** from the unit's measured catchment. Nothing named is still a lead; any named area
 *    in range makes it one; only named-and-far rejects.
 * 5. **Dates** resolved against today *in the unit's time zone*, never invented.
 *
 * Free of Node APIs, so the MCP server can import it under type stripping.
 */

export interface UnitProfile {
  readonly id: string
  readonly name: string
  readonly timezone: string
  readonly bedrooms: number
  readonly areas: {
    readonly accept: ReadonlyArray<string>
    readonly borderline: ReadonlyArray<string>
    readonly reject: ReadonlyArray<string>
  }
}

export interface Message {
  readonly text: string
  readonly sender?: string
  readonly group?: string
  /** As written in the chat export; kept for the report, not parsed. */
  readonly at?: string
}

export type Verdict = "lead" | "noise"
export type Direction = "seeking" | "offering" | "unclear"
export type Unit = "match" | "weak" | "larger" | "unstated"
export type AreaTier = "accept" | "borderline" | "reject" | "unstated"
export type Confidence = "high" | "medium" | "low"

export interface Triaged extends Message {
  readonly verdict: Verdict
  readonly reason: string
  readonly direction: Direction
  readonly unit: Unit
  readonly area?: string
  readonly areaTier: AreaTier
  readonly checkIn?: string
  readonly checkOut?: string
  readonly datesStated: boolean
  readonly confidence?: Confidence
}

// ---- Language ----------------------------------------------------------------------------------

const normalise = (text: string): string => text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim()

const any = (text: string, patterns: ReadonlyArray<RegExp>): number => patterns.filter((p) => p.test(text)).length

/** Asking for something: English, Swahili and Sheng openers seen in the groups. */
const SEEKING: ReadonlyArray<RegExp> = [
  /\blooking for\b/,
  /\banyone (with|got|has|have|hosting)\b/,
  /\bwho has\b/,
  /\bneed(s|ed)?\b/,
  /\bin need of\b/,
  /\bsearching for\b/,
  /\bhook me up\b/,
  /\bhelp me find\b/,
  /\bkindly assist\b/,
  /\b(my )?(client|guest)s? (needs?|wants?)\b/,
  /\bany leads on\b/,
  /\brecommend a\b/,
  /\bis there (a|any)\b/,
  /\bany (available|bnb|airbnb|1 ?br|one ?bed|place|studio|unit|apartment)\b/,
  /\b(ni)?natafuta\b/,
  /\btunatafuta\b/,
  /\banatafuta\b/,
  /\b(ni)?nahitaji\b/,
  /\b(a|ni)?nataka\b/,
  /\banataka\b/,
  /\bnaomba\b/,
  /\bnani ana\b/,
  /\bkuna (mtu|mahali|any)\b/,
  /\bnisaidie\b/,
  /\bnipatie\b/,
  /\bnaeza pata wapi\b/,
  /\b(mtu|yeyote) ana\b/,
  /\bnauliza\b/,
  /\bnaded\b/
]

/** Offering something: the vocabulary of an advert. */
const OFFERING: ReadonlyArray<RegExp> = [
  /\b(now )?available\b(?! \?)/,
  /\bfor booking\b/,
  /\bbook (now|with us)\b/,
  /\bdm (to book|me|for)\b/,
  /\binbox (me|us)\b/,
  /\bwe have\b/,
  /\boffering\b/,
  /\bvacant\b/,
  /\bto let\b/,
  /\bfor rent\b/,
  /\bfully furnished\b/,
  /\bself[- ]contained\b/,
  /\brates?\b/,
  /\bper night\b/,
  /\b(ni)?nayo\b/,
  /\btu(na|nayo)\b/,
  /\btupo na\b/,
  /\binapatikana\b/,
  /\bbei ni\b/,
  /\bkwa (siku|usiku)\b/,
  /\bpiga simu\b/,
  /\bwasiliana nami\b/,
  /\btunakodisha\b/,
  /\b(iko|ipo) available\b/,
  /\bnauza\b/
]

/** A Kenyan phone number: agents post their own contact. */
const PHONE = /(\+?254|\b0)[17]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/
/** A price stated as a rate is an offer; a budget is not. */
const RATE =
  /(ksh\.?|kes|sh\.?)\s?\d[\d,.]*k?\s?(\/|per|a|kwa)\s?(night|nite|usiku|siku|day)|\b\d[\d,.]*k?\s?(pn|p\/n|\/night|per night)\b/
const BUDGET = /\b(budget|bajeti|nina \d)/
const RATE_CARD = /✅|📍|🛏|🛌|📶|🅿|🏊/gu

/** Words that make a message about somewhere to stay, as opposed to a car or a cleaner. */
const ACCOMMODATION =
  /\b(bnb|airbnb|place|room|bed ?room|bedroom|bdrm|br|bd|studio|bedsitter|keja|house|apartment|apt|unit|stay|accommodation|lodging|crib|nyumba|chumba|mahali pa kulala|kulala|night|nights|usiku)\b|\d ?br\b/

/** Seeking something that is not a place to stay. */
const OTHER_SERVICE = /\b(cleaner|plumber|electrician|driver|caretaker|photographer|car|gari|furniture|tv|laptop)\b/

const direction = (text: string): Direction => {
  const seeking = any(text, SEEKING) + (/\?\s*$|\?/.test(text) ? 1 : 0)
  const budgetOnly = BUDGET.test(text)
  const offering = any(text, OFFERING) +
    (PHONE.test(text) ? 2 : 0) +
    (RATE.test(text) && !budgetOnly ? 2 : 0) +
    Math.min(2, (text.match(RATE_CARD) ?? []).length)
  // A seeking verb outweighs a stated budget, but not a listing's structure.
  if (any(text, SEEKING) > 0 && seeking > offering) return "seeking"
  if (offering > 0) return "offering"
  return "unclear"
}

// ---- Unit --------------------------------------------------------------------------------------

const NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  moja: 1,
  mbili: 2,
  tatu: 3,
  nne: 4,
  tano: 5
}

const bedroomsAsked = (text: string): number | "studio" | undefined => {
  if (/\b(studio|bedsitter|bed sitter|single room)\b/.test(text)) return "studio"
  if (/\bchumba kimoja\b/.test(text)) return 1
  if (/\b(villa|whole house|mansion|maisonette)\b/.test(text)) return 4
  const match = /\b(\d|one|two|three|four|five)[ -]?(br|bd|bdrm|bed ?rooms?|bedroom|bed)\b/.exec(text)
  if (match === null) return undefined
  return /^\d$/.test(match[1]!) ? Number(match[1]) : NUMBERS[match[1]!]
}

const unitFit = (text: string, bedrooms: number): Unit => {
  const asked = bedroomsAsked(text)
  if (asked === undefined) return "unstated"
  if (asked === "studio") return "weak"
  return asked <= bedrooms ? "match" : "larger"
}

// ---- Location ----------------------------------------------------------------------------------

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const mentions = (text: string, area: string): boolean =>
  new RegExp(`(^|[^a-z])${escape(normalise(area))}([^a-z]|$)`).test(text)

const location = (text: string, profile: UnitProfile): { tier: AreaTier; area?: string } => {
  for (const tier of ["accept", "borderline", "reject"] as const) {
    const area = profile.areas[tier].find((name) => mentions(text, name))
    // Any named area in range makes it a lead, so accept is checked first and wins.
    if (area !== undefined) return { tier, area }
  }
  return { tier: "unstated" }
}

// ---- Dates -------------------------------------------------------------------------------------

/** A calendar day, as `YYYY-MM-DD`, and arithmetic on it in whole days. */
type Day = string

const addDays = (day: Day, n: number): Day => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const weekday = (day: Day): number => new Date(`${day}T00:00:00Z`).getUTCDay()

/** Today in the unit's time zone: a message read at 01:00 EAT still means that day by "leo". */
export const todayIn = (timezone: string, now: Date): Day =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now
  )

const WEEKDAYS: ReadonlyArray<[RegExp, number]> = [
  [/\b(sunday|sun|jumapili)\b/, 0],
  [/\b(monday|mon|jumatatu)\b/, 1],
  [/\b(tuesday|tue|tues|jumanne)\b/, 2],
  [/\b(wednesday|wed|jumatano)\b/, 3],
  [/\b(thursday|thu|thurs|alhamisi)\b/, 4],
  [/\b(friday|fri|ijumaa)\b/, 5],
  [/\b(saturday|sat|jumamosi)\b/, 6]
]

const MONTH_NAMES: ReadonlyArray<[string, number]> = [
  ["january|jan|januari", 1],
  ["february|feb|februari", 2],
  ["march|mar|machi", 3],
  ["april|apr|aprili", 4],
  ["may|mei", 5],
  ["june|jun|juni", 6],
  ["july|jul|julai", 7],
  ["august|aug|agosti", 8],
  ["september|sept|sep|septemba", 9],
  ["october|oct|oktoba", 10],
  ["november|nov|novemba", 11],
  ["december|dec|desemba", 12]
]
const MONTH = MONTH_NAMES.map(([names]) => names).join("|")

/**
 * A month only counts beside a day number ("15 August", "Aug 15th", "15th-18th of May"):
 * "may" and "mar" are words too, and "I may need 3 nights" is not the 3rd of May.
 */
const monthOf = (text: string): number | undefined => {
  const match = new RegExp(
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b|\\b(${MONTH})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`
  ).exec(text)
  const name = match?.[1] ?? match?.[2]
  return name === undefined ? undefined : MONTH_NAMES.find(([names]) => names.split("|").includes(name))?.[1]
}

const COUNT: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  mmoja: 1,
  moja: 1,
  mbili: 2,
  tatu: 3,
  nne: 4,
  tano: 5,
  sita: 6,
  saba: 7
}

/** "3 nights", "siku tatu", "usiku mmoja", "a week". */
const nightsAsked = (text: string): number | undefined => {
  const english = /\b(\d{1,2}|one|two|three|four|five|six|seven) ?(nights?|days?)\b/.exec(text)
  if (english !== null) return /^\d+$/.test(english[1]!) ? Number(english[1]) : COUNT[english[1]!]
  const swahili = /\b(siku|usiku) (mmoja|moja|mbili|tatu|nne|tano|sita|saba|\d{1,2})\b/.exec(text)
  if (swahili !== null) return /^\d+$/.test(swahili[2]!) ? Number(swahili[2]) : COUNT[swahili[2]!]
  if (/\b(a|one) week\b|\bwiki moja\b/.test(text)) return 7
  return undefined
}

/** The next date (today or later) falling on day-of-month `dom`, in `month` if given. */
const nextDayOfMonth = (today: Day, dom: number, month?: number): Day | undefined => {
  const [y, m] = today.split("-").map(Number) as [number, number]
  for (let offset = 0; offset < 14; offset++) {
    const year = y + Math.floor((m - 1 + offset) / 12)
    const mon = ((m - 1 + offset) % 12) + 1
    if (month !== undefined && mon !== month) continue
    const candidate = `${year}-${String(mon).padStart(2, "0")}-${String(dom).padStart(2, "0")}`
    // Rejects 31 June and the like: the date must survive a round trip.
    if (new Date(`${candidate}T00:00:00Z`).toISOString().slice(0, 10) !== candidate) continue
    if (candidate >= today) return candidate
  }
  return undefined
}

const nextWeekday = (today: Day, target: number): Day => addDays(today, (target - weekday(today) + 7) % 7)

export const dates = (text: string, today: Day): { checkIn?: Day; checkOut?: Day } => {
  const nights = nightsAsked(text)
  const span = (checkIn: Day, defaultNights?: number) => {
    const n = nights ?? defaultNights
    return n === undefined ? { checkIn } : { checkIn, checkOut: addDays(checkIn, n) }
  }

  // A day range: "15 mpaka 18", "20-22", "20th to 22nd", "tarehe 15 hadi 18 August".
  const range =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|to|till|until|mpaka|hadi)\s*(\d{1,2})(?:st|nd|rd|th)?\b(?!\s?(?:br|bd|bed|k\b|nights?|days?|people|pax|guests?))/
      .exec(text)
  const month = monthOf(text)
  if (range !== null) {
    const from = Number(range[1])
    const to = Number(range[2])
    const checkIn = nextDayOfMonth(today, from, month)
    if (checkIn !== undefined && from >= 1 && from <= 31 && to >= 1 && to <= 31) {
      // "28-2" crosses into the next month.
      const checkOut = to > from ? nextDayOfMonth(checkIn, to) : nextDayOfMonth(addDays(checkIn, 1), to)
      return checkOut === undefined ? { checkIn } : { checkIn, checkOut }
    }
  }

  // A single dated day: "tarehe 15", "from 12th", "on the 3rd", "12 August".
  const single =
    /\b(?:tarehe|from|kuanzia|toka|on the|on)\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(text) ??
      (month !== undefined
        ? new RegExp(`\\b(\\d{1,2})\\s+(?:of\\s+)?(?:${MONTH})\\b|\\b(?:${MONTH})\\.?\\s+(\\d{1,2})\\b`).exec(text)
        : null)
  if (single !== null) {
    const dom = Number(single[1] ?? single[2])
    const checkIn = dom >= 1 && dom <= 31 ? nextDayOfMonth(today, dom, month) : undefined
    if (checkIn !== undefined) return span(checkIn)
  }

  if (/\bkesho kutwa\b|\bday after tomorrow\b/.test(text)) return span(addDays(today, 2), 1)
  if (/\b(tonight|today|leo)\b/.test(text)) return span(today, 1)
  if (/\b(tomorrow|tmrw|tmr|kesho)\b/.test(text)) return span(addDays(today, 1), 1)
  if (/\b(this )?(weekend|wikendi)\b/.test(text)) {
    const friday = weekday(today) === 6 || weekday(today) === 0 ? today : nextWeekday(today, 5)
    return { checkIn: friday, checkOut: nextWeekday(addDays(friday, 1), 0) }
  }
  const day = WEEKDAYS.find(([pattern]) => pattern.test(text))
  if (day !== undefined) return span(nextWeekday(today, day[1]))
  return {}
}

// ---- Triage ------------------------------------------------------------------------------------

export const triage = (message: Message, profile: UnitProfile, now: Date): Triaged => {
  const text = normalise(message.text)
  const today = todayIn(profile.timezone, now)
  const way = direction(text)
  const unit = unitFit(text, profile.bedrooms)
  const where = location(text, profile)
  const when = dates(text, today)
  const datesStated = when.checkIn !== undefined
  const base = {
    ...message,
    direction: way,
    unit,
    areaTier: where.tier,
    ...(where.area !== undefined ? { area: where.area } : {}),
    ...when,
    datesStated
  }
  const noise = (reason: string): Triaged => ({ ...base, verdict: "noise", reason })

  if (way === "offering") return noise("advertising, not seeking")
  if (way === "unclear") {
    return noise(
      ACCOMMODATION.test(text) ? "direction unclear, worth a look" : "no sign the sender is looking for anything"
    )
  }
  if (!ACCOMMODATION.test(text) || (OTHER_SERVICE.test(text) && unit === "unstated")) {
    return noise("seeking something other than a place to stay")
  }
  if (unit === "larger") return noise(`needs more than ${profile.bedrooms} bedroom${profile.bedrooms === 1 ? "" : "s"}`)
  if (where.tier === "reject") return noise(`out of the area (${where.area})`)

  // What had to be assumed rather than read: the unit and the dates. Location unstated is
  // deliberate, not an inference, so it does not count against confidence.
  const inferred = (unit === "unstated" ? 1 : 0) + (datesStated ? 0 : 1)
  const confidence: Confidence = unit === "weak" || inferred >= 2 ? "low" : inferred === 1 ? "medium" : "high"
  const reason = [
    "seeking",
    unit === "match"
      ? `${profile.bedrooms}-bedroom`
      : unit === "weak"
      ? "studio or bedsitter (weak match)"
      : "unit unstated",
    where.tier === "accept"
      ? `in area (${where.area})`
      : where.tier === "borderline"
      ? `borderline area (${where.area})`
      : "location unstated",
    datesStated ? "dated" : "dates unstated"
  ].join(", ")
  return { ...base, verdict: "lead", reason, confidence }
}

// ---- Chat exports ------------------------------------------------------------------------------

/**
 * Messages from a pasted chat: WhatsApp's exports (`[12/08/2026, 01:12:33] Name: text` from iOS,
 * `12/08/2026, 01:12 - Name: text` from Android), continuation lines kept with their message.
 * Text in neither format is split on blank lines, one message per block.
 */
export const parseChat = (pasted: string, group?: string): Array<Message> => {
  const header = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}:\d{2}(?::\d{2})?(?: ?[ap]m)?)\]?(?: -)? ([^:]{1,60}): (.*)$/i
  const lines = pasted.replace(/\r\n/g, "\n").replace(/[‎‏]/g, "").split("\n")
  if (!lines.some((line) => header.test(line))) {
    return pasted.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block !== "").map((text) => ({
      text,
      ...(group !== undefined ? { group } : {})
    }))
  }
  const messages: Array<{ text: string; sender: string; at: string }> = []
  for (const line of lines) {
    const match = header.exec(line)
    if (match !== null) messages.push({ at: match[1]!, sender: match[2]!.trim(), text: match[3]! })
    else if (messages.length > 0 && line.trim() !== "") messages.at(-1)!.text += `\n${line}`
  }
  return messages
    .filter((m) => !/^<media omitted>$|^this message was deleted$/i.test(m.text.trim()))
    .map((m) => ({ ...m, ...(group !== undefined ? { group } : {}) }))
}

// ---- Report ------------------------------------------------------------------------------------

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }

const stayWindow = (lead: Triaged): string =>
  lead.checkIn === undefined
    ? "dates unstated"
    : lead.checkOut === undefined
    ? `from ${lead.checkIn}`
    : `${lead.checkIn} to ${lead.checkOut}`

/** The sweep as the owner reads it: leads first and actionable, noise as one line of counts. */
export const report = (triaged: ReadonlyArray<Triaged>, profile: UnitProfile): string => {
  const leads = triaged
    .filter((t) => t.verdict === "lead")
    .sort((a, b) => RANK[a.confidence!] - RANK[b.confidence!])
  const noise = triaged.filter((t) => t.verdict === "noise")
  const counts = new Map<string, number>()
  for (const n of noise) counts.set(n.reason, (counts.get(n.reason) ?? 0) + 1)

  const lines = [`## Leads for ${profile.name} (${leads.length})`, ""]
  if (leads.length === 0) lines.push("None in these messages.", "")
  leads.forEach((lead, i) => {
    lines.push(`**${i + 1}. ${stayWindow(lead)}, ${lead.confidence} confidence**`)
    for (const line of lead.text.split("\n")) lines.push(`> ${line}`)
    lines.push(
      [lead.sender, lead.group, lead.at].filter((s) => s !== undefined).join(" · ") || "(no sender)",
      `${lead.reason}. Availability: not checked.`,
      ""
    )
  })
  if (leads.length > 0) {
    lines.push("Reply with the listing (photos and price) first, not a question: the first host to send them wins.", "")
  }
  // Dropped, but only because no verb said which way it went: the owner can overrule these.
  const unclear = noise.filter((n) => n.reason === "direction unclear, worth a look")
  if (unclear.length > 0) {
    lines.push("## Direction unclear (check by eye)", "")
    for (const n of unclear) lines.push(`> ${n.text.split("\n").join(" ")}`, "")
  }
  lines.push(
    "## Swept",
    "",
    `${triaged.length} message${triaged.length === 1 ? "" : "s"}: ${leads.length} lead${
      leads.length === 1 ? "" : "s"
    }, ${noise.length} noise.`
  )
  for (const [reason, n] of counts) lines.push(`- ${reason}: ${n}`)
  lines.push("")
  return lines.join("\n")
}
