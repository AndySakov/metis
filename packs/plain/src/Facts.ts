/**
 * The facts a rewrite must keep: every number, date, time, amount, link and email address in the
 * original, written exactly as they were.
 *
 * A model asked to make text plainer will also, sometimes, round a figure, drop a date or tidy a
 * link away. Those are the changes a reader cannot catch, because the rewrite still reads well. So
 * the check is mechanical and the model's word is never taken for it: each fact is looked for, as
 * written, in the rewrite.
 */

const URL = /\bhttps?:\/\/[^\s<>"'`]+/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
/** A number with its inner punctuation: `1,250`, `10.5`, `2026-10-24`, `15:30`, `3/4`. */
const NUMBER = /\d(?:[\d,.:/-]*\d)?/g

/** The facts in `text`, each once, links and emails first so the digits inside them are theirs. */
export const factsOf = (text: string): Array<string> => {
  const facts: Array<string> = []
  let rest = text
  for (const pattern of [URL, EMAIL]) {
    rest = rest.replace(pattern, (match) => {
      facts.push(match.replace(/[.,;:!?)]+$/, ""))
      return " "
    })
  }
  for (const match of rest.match(NUMBER) ?? []) facts.push(match)
  return [...new Set(facts)]
}

export interface Check {
  readonly passed: boolean
  /** Facts of the original that the rewrite does not contain as written. */
  readonly missing: ReadonlyArray<string>
  /** Whether the rewrite is longer than the original, which a plainer version should not be. */
  readonly longer: boolean
}

export const check = (original: string, rewrite: string): Check => {
  const missing = factsOf(original).filter((fact) => !rewrite.includes(fact))
  const longer = rewrite.trim().length > original.trim().length
  return { passed: missing.length === 0 && !longer, missing, longer }
}
