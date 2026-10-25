/**
 * Placeholders in a planned step's input, filled from the intent at planning time.
 *
 * A plan proposed by something that must not see the user's pasted text (a pack's template, or
 * the model) names it as `{{pasted}}`, and the goal as `{{goal}}`. The text goes in here, as data
 * the step will carry with its labels, never as words the proposer read.
 */

/** `{{goal}}` and `{{pasted}}` in every string of `value`, filled in. */
export const fill = (value: unknown, goal: string, pasted: string): unknown => {
  if (typeof value === "string") {
    return value.replaceAll("{{goal}}", goal).replaceAll("{{pasted}}", pasted).trim()
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, goal, pasted))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, goal, pasted)]))
  }
  return value
}
