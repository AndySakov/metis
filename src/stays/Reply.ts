/**
 * A first reply to a booking lead, drafted for the owner to send.
 *
 * Three lessons decide its shape. In August, most chased leads died on an unanswered message from
 * the host, usually a qualifying question sent as the opener ("What's the budget?"); the people
 * posting are fielding several hosts at once, and whoever sends the place and the price first
 * wins. So the draft opens with the listing and the price for the nights asked, and keeps one
 * question for the end, one that moves toward a booking. And a wrong price or a promised amenity
 * costs a review, so the draft states only what the unit's profile records: a missing fact is a
 * visible `[placeholder]`, listed for the owner to fill, never a guess.
 *
 * It answers in the lead's language, English or Swahili, and is a draft only: nothing here sends.
 * Free of Node APIs, like the rest of `src/stays/`.
 */

import type { Answer } from "./Availability.ts"
import type { Triaged, UnitProfile } from "./Triage.ts"

export type Language = "en" | "sw"

export interface Draft {
  readonly text: string
  readonly language: Language
  /** The `[placeholders]` in `text`: facts the profile does not record, to fill before sending. */
  readonly placeholders: ReadonlyArray<string>
  /** What the draft assumes and nothing checked, to confirm before sending. */
  readonly unverified: ReadonlyArray<string>
}

// ---- Language ----------------------------------------------------------------------------------

const SWAHILI =
  /\b(natafuta|ninatafuta|tunatafuta|anatafuta|nahitaji|ninahitaji|naomba|nataka|anataka|kuna|iko|ipo|leo|kesho|kutwa|tarehe|usiku|siku|keja|karibu|mpaka|hadi|nauliza|habari|nani|ana|ya|na|kwa|wa|hii|ijayo|mteja|nisaidie|mtu)\b/g
const ENGLISH =
  /\b(the|a|an|for|in|with|anyone|looking|need|needs|from|any|who|has|is|nights?|tonight|tomorrow|weekend|please|place|client|around|near)\b/g

/** The lead's language, by which of the two it uses more; a tie is English. */
export const languageOf = (text: string): Language => {
  const lower = text.toLowerCase()
  return (lower.match(SWAHILI) ?? []).length > (lower.match(ENGLISH) ?? []).length ? "sw" : "en"
}

// ---- Pieces ------------------------------------------------------------------------------------

/** A first name worth greeting: a word that looks like a name, not "Agent" or a phone number. */
const firstName = (sender: string | undefined): string | undefined => {
  const word = sender?.trim().split(/\s+/)[0]
  if (word === undefined || !/^\p{Lu}\p{Ll}{1,20}$/u.test(word)) return undefined
  return /^(agent|host|admin|client|mteja|bnb|airbnb)$/i.test(word) ? undefined : word
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MONTHS_SW = ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ago", "Sep", "Okt", "Nov", "Des"]
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const day = (iso: string, language: Language): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  return language === "sw"
    ? `${d.getUTCDate()} ${MONTHS_SW[d.getUTCMonth()]}`
    : `${WEEKDAYS_EN[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]}`
}

const nextDay = (iso: string): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

const nightsBetween = (checkIn: string, checkOut: string): number =>
  Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000)

const span = (checkIn: string, checkOut: string, language: Language): string =>
  language === "sw"
    ? `tarehe ${day(checkIn, language)} hadi ${day(checkOut, language)}`
    : `${day(checkIn, language)} to ${day(checkOut, language)}`

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** "21 Aug to 23 Aug are taken", "10 Aug to 11 Aug is taken": one night is one thing. */
const plural = (lead: Triaged): string =>
  lead.checkOut !== undefined && nightsBetween(lead.checkIn!, lead.checkOut) > 1 ? "are" : "is"

const money = (currency: string, amount: number): string => `${currency} ${amount.toLocaleString("en-US")}`

// ---- The draft ---------------------------------------------------------------------------------

/**
 * A reply to `lead`, from what `profile` records. With availability known, the dates are offered
 * or, when taken, the next free window is; without it, the listing still goes first and the one
 * question is about dates.
 */
export const draft = (lead: Triaged, profile: UnitProfile): Draft => {
  const language = languageOf(lead.text)
  const listing = profile.listing ?? {}
  const placeholders: Array<string> = []
  const fill = (value: string | undefined, name: string): string => {
    if (value !== undefined) return value
    placeholders.push(`[${name}]`)
    return `[${name}]`
  }
  const sw = language === "sw"
  const name = firstName(lead.sender)
  const forClient = /\b(client|mteja|guest)\b/i.test(lead.text)

  const unit = sw
    ? fill(listing.headlineSw ?? listing.headline, "listing headline")
    : fill(listing.headline, "listing headline")
  const highlights = listing.highlights !== undefined && listing.highlights.length > 0
    ? listing.highlights.length === 1
      ? listing.highlights[0]!
      : `${listing.highlights.slice(0, -1).join(", ")} ${sw ? "na" : "and"} ${listing.highlights.at(-1)}`
    : undefined
  const unverified: Array<string> = []

  const availability: Answer | undefined = lead.availability
  const booked = availability?.verdict === "BOOKED"
  // Offer the dates asked for unless they are taken; then offer the next free window instead.
  const offered = booked && availability?.nextWindow !== undefined
    ? availability.nextWindow
    : lead.checkIn !== undefined && !booked
    ? { checkIn: lead.checkIn, checkOut: lead.checkOut ?? nextDay(lead.checkIn) }
    : undefined
  const nights = offered !== undefined ? nightsBetween(offered.checkIn, offered.checkOut) : 0

  const rate = listing.nightlyRate
  const currency = listing.currency ?? "Ksh"
  const price = rate === undefined
    ? `${fill(undefined, "nightly rate")} ${sw ? "kwa usiku" : "a night"}`
    : nights > 1
    ? sw
      ? `${money(currency, rate)} kwa usiku, usiku ${nights} ni ${money(currency, rate * nights)}`
      : `${money(currency, rate)} a night, ${money(currency, rate * nights)} for the ${nights} nights`
    : sw
    ? `${money(currency, rate)} kwa usiku`
    : `${money(currency, rate)} a night`

  const greeting = sw ? `Habari${name !== undefined ? ` ${name}` : ""}!` : `Hi${name !== undefined ? ` ${name}` : ""}!`
  const who = forClient ? (sw ? " kwa mteja wako" : " for your client") : ""

  // The opener: the place and when it is free, before anything is asked.
  const asked = lead.checkIn !== undefined ? span(lead.checkIn, lead.checkOut ?? nextDay(lead.checkIn), language) : ""
  const opener = (() => {
    if (booked && offered === undefined) {
      return sw
        ? `Nina ${unit}${who}, lakini ${asked} imeshachukuliwa.`
        : `I have ${unit}${who}, but ${asked} ${plural(lead)} taken.`
    }
    if (booked && offered !== undefined) {
      return sw
        ? `Nina ${unit}${who}. ${capitalised(asked)} imeshachukuliwa, lakini inapatikana ${
          span(offered.checkIn, offered.checkOut, language)
        }.`
        : `I have ${unit}${who}. ${asked} ${plural(lead)} taken, but it's free ${
          span(offered.checkIn, offered.checkOut, language)
        }.`
    }
    if (offered !== undefined && nights > 0) {
      const dates = span(offered.checkIn, offered.checkOut, language)
      // Free only if the sheet said so; otherwise the dates are offered, and flagged to check.
      if (availability === undefined) {
        unverified.push(`availability was not checked: confirm ${dates} is free before sending`)
        return sw ? `Nina ${unit}${who} kwa ${dates}.` : `I have ${unit}${who} for ${dates}.`
      }
      return sw
        ? `Nina ${unit}${who}, inapatikana ${dates}.`
        : `I have ${unit}${who}, ${availability.verdict === "CONTESTED" ? "available" : "free"} ${dates}.`
    }
    return sw ? `Nina ${unit}${who}.` : `I have ${unit}${who}.`
  })()

  const contested = availability?.verdict === "CONTESTED"
    ? sw
      ? " Kuna mtu mwingine ameuliza tarehe hizo pia, kwa hivyo naweza kukushikilia ukithibitisha leo."
      : " Someone else has asked about those dates too, so I can hold them if you confirm today."
    : ""
  const details = [
    highlights !== undefined ? (sw ? `Ina ${highlights}.` : `It has ${highlights}.`) : undefined,
    sw ? `Bei: ${price}.` : `${price[0]!.toUpperCase()}${price.slice(1)}.`,
    sw ? `Picha: ${fill(listing.photos, "photos link")}` : `Photos: ${fill(listing.photos, "photos link")}`
  ].filter((line): line is string => line !== undefined)

  // One question, and it moves toward a booking.
  const question = booked && offered === undefined
    ? sw ? "Tarehe zako zinaweza kubadilika?" : "Are your dates flexible?"
    : offered !== undefined && nights > 0
    ? sw ? "Nikushikilie tarehe hizo?" : `Shall I hold ${booked ? "those dates" : "them"} for you?`
    : sw
    ? "Ni tarehe gani unazotaka?"
    : "Which dates are you looking at?"

  const text = `${greeting} ${opener}${contested}\n${details.join("\n")}\n${question}`
  return { text, language, placeholders: [...new Set(placeholders)], unverified }
}
