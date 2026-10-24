/**
 * Redaction: personal details found in text and replaced with a marker naming their kind.
 *
 * Each kind is found by its shape and, where the shape alone would catch too much, a check on the
 * value: a card number must pass the Luhn check, and a phone number must be written the way phone
 * numbers are (a leading `+` or `0`), so an amount, a year or an order number is left alone. What
 * is not one of these kinds (a name, an address) is not found. That limit is the contract, and the
 * result counts what it replaced so a reader can see what was and was not touched.
 */

export const KINDS = ["email", "card", "phone", "ip"] as const
export type Kind = (typeof KINDS)[number]

export interface Redacted {
  readonly text: string
  readonly found: Record<Kind, number>
}

const luhn = (digits: string): boolean => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

const digitsOf = (s: string): string => s.replace(/\D/g, "")

const FINDERS: Record<Kind, { readonly pattern: RegExp; readonly accept: (match: string) => boolean }> = {
  email: { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, accept: () => true },
  card: {
    pattern: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    accept: (match) => luhn(digitsOf(match))
  },
  phone: {
    pattern: /(?<![\w+])(?:\+|0|\(0)[\d ()-]{7,18}\d(?!\w)/g,
    accept: (match) => {
      const n = digitsOf(match).length
      return n >= 9 && n <= 15
    }
  },
  ip: {
    pattern: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g,
    accept: () => true
  }
}

/**
 * `text` with every detail of the `kinds` asked for replaced by `[kind]`. Kinds run in a fixed
 * order, emails first, so a number inside an address is never also counted as a phone.
 */
export const redact = (text: string, kinds: ReadonlyArray<Kind> = KINDS): Redacted => {
  const found: Record<Kind, number> = { email: 0, card: 0, phone: 0, ip: 0 }
  let out = text
  for (const kind of KINDS) {
    if (!kinds.includes(kind)) continue
    const { accept, pattern } = FINDERS[kind]
    out = out.replace(pattern, (match) => {
      if (!accept(match)) return match
      found[kind]++
      return `[${kind}]`
    })
  }
  return { text: out, found }
}
