/**
 * Reading a tool descriptor from disk, with the schemas it points at.
 *
 * A descriptor names its capability's input and output schemas by `$ref`, relative to the
 * descriptor's own file. Those references are resolved here, once, at load: a `ToolSpec` held in
 * the registry carries the schemas themselves, so anything checking an output against what the
 * capability declares (sampled verification, ADR-014) checks the real contract rather than an
 * object with nothing in it but a pointer.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { Schema } from "effect"

import { ToolSpec } from "../domain/ToolSpec.js"

const SPECS = fileURLToPath(new URL("../../specs/", import.meta.url))
const CANONICAL = "https://schema.metis.dev/"

type JsonSchema = Record<string, unknown>

/**
 * `schema` with a top-level file `$ref` replaced by that file's contents. References inside the
 * target stay as written: its local `#/$defs` pointers travel with it, and the checks that read a
 * resolved schema look only at its top level.
 */
export const resolveSchema = (schema: JsonSchema | undefined, from: string): JsonSchema | undefined => {
  const ref = schema?.$ref
  if (typeof ref !== "string" || ref.startsWith("#")) return schema
  const [location] = ref.split("#")
  const target = ref.startsWith(CANONICAL)
    ? resolve(SPECS, location!.slice(CANONICAL.length))
    : resolve(dirname(from), location!)
  return JSON.parse(readFileSync(target, "utf8")) as JsonSchema
}

/** The descriptor at `file`, decoded, with its input and output schemas resolved. */
export const readDescriptor = (file: string): ToolSpec => {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  const inputSchema = resolveSchema(raw.inputSchema as JsonSchema | undefined, file)
  const outputSchema = resolveSchema(raw.outputSchema as JsonSchema | undefined, file)
  return Schema.decodeUnknownSync(ToolSpec)({
    ...raw,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {})
  })
}
