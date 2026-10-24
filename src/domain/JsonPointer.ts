/**
 * JSON Pointer (RFC 6901): how a plan names a place inside a tool's input or output.
 *
 * `""` is the whole document; otherwise each `/`-separated token is a key or an array index, with
 * `~1` standing for `/` and `~0` for `~`.
 */

import { Schema } from "effect"

export const JsonPointer = Schema.String.pipe(
  Schema.pattern(/^(?:\/(?:[^~/]|~[01])*)*$/),
  Schema.brand("JsonPointer"),
  Schema.annotations({ description: "A JSON Pointer (RFC 6901)." })
)
export type JsonPointer = typeof JsonPointer.Type

export const tokens = (pointer: string): ReadonlyArray<string> =>
  pointer === "" ? [] : pointer.slice(1).split("/").map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"))

/** The pointer to the value containing this one. The whole document has no parent. */
export const parent = (pointer: string): string => pointer.slice(0, Math.max(0, pointer.lastIndexOf("/")))

const own = (container: unknown, token: string): boolean =>
  Array.isArray(container)
    ? /^(?:0|[1-9]\d*)$/.test(token) && Number(token) < container.length
    : container !== null && typeof container === "object" && Object.hasOwn(container, token)

/** The value at `pointer`, or `undefined` if nothing is there. Only own properties are followed. */
export const get = (document: unknown, pointer: string): unknown => {
  let current = document
  for (const token of tokens(pointer)) {
    if (!own(current, token)) return undefined
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

/** Whether `pointer` can be set in `document`: its parent exists and holds objects or arrays. */
export const settable = (document: unknown, pointer: string): boolean => {
  if (pointer === "") return false
  const container = get(document, parent(pointer))
  const last = tokens(pointer).at(-1)!
  if (Array.isArray(container)) return /^(?:0|[1-9]\d*)$/.test(last) && Number(last) <= container.length
  return container !== null && typeof container === "object" && last !== "__proto__"
}

/** A copy of `document` with `value` at `pointer`, which must be `settable`. */
export const set = <A>(document: A, pointer: string, value: unknown): A => {
  const copy = structuredClone(document)
  const container = get(copy, parent(pointer)) as Record<string, unknown>
  container[tokens(pointer).at(-1)!] = value
  return copy
}
