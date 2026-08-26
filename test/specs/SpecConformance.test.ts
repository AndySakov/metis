import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { Artifact } from "../../src/domain/Artifact.js"
import { Event } from "../../src/domain/Event.js"
import { Intent, IntentDraft } from "../../src/domain/Intent.js"
import { Plan } from "../../src/domain/Plan.js"
import { Policy, PolicyDecision } from "../../src/domain/Policy.js"
import { ToolSpec } from "../../src/domain/ToolSpec.js"

/**
 * ADR-004 makes the files in `specs/` canonical and requires CI to validate examples against
 * schemas and fail on broken `$ref`s. ADR-011 adds that when the same contract exists as both a
 * spec and an Effect Schema, one must validate the other rather than being maintained in parallel.
 *
 * This is that check. It is the mechanism that stops the drift the repository was audited for from
 * silently coming back: a spec example that the code cannot decode is a failing test, not a
 * discrepancy someone notices months later.
 */

const SPECS = resolve(__dirname, "../../specs")

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

/** Every `*.json` under `specs/`, recursively. */
const allSpecFiles = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return allSpecFiles(full)
    return entry.name.endsWith(".json") ? [full] : []
  })

const examplesOf = (path: string): Array<unknown> => {
  const spec = readJson(path)
  return Array.isArray(spec.examples) ? spec.examples : []
}

describe("spec examples decode with the schemas the code actually uses", () => {
  const cases = [
    { file: "Intent.schema.json", schema: Intent },
    { file: "IntentDraft.schema.json", schema: IntentDraft },
    { file: "Plan.schema.json", schema: Plan },
    { file: "Artifact.schema.json", schema: Artifact },
    { file: "Event.schema.json", schema: Event },
    { file: "policy/Policy.schema.json", schema: Policy },
    { file: "policy/PolicyDecision.schema.json", schema: PolicyDecision }
  ] as const

  for (const { file, schema } of cases) {
    it(`${file}`, () => {
      const examples = examplesOf(join(SPECS, file))
      expect(examples.length).toBeGreaterThan(0)
      for (const example of examples) {
        expect(() => Schema.decodeUnknownSync(schema as Schema.Schema<any, any>)(example)).not.toThrow()
      }
    })
  }
})

describe("every ToolSpec example conforms (ADR-006, ADR-017)", () => {
  const dir = join(SPECS, "tools/examples")
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()

  it("there are tool examples to check", () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(file, () => {
      const spec = readJson(join(dir, file))
      expect(() => Schema.decodeUnknownSync(ToolSpec)(spec)).not.toThrow()
    })
  }

  it("no example still declares container/WASM packaging (ADR-017 removed it)", () => {
    for (const file of files) {
      const spec = readJson(join(dir, file))
      expect(spec.implementation, `${file} still has an implementation block`).toBeUndefined()
      expect(spec.sandboxed, `${file} still claims sandboxed`).toBeUndefined()
    }
  })

  it("every example declares idempotency explicitly (ADR-016)", () => {
    for (const file of files) {
      const spec = readJson(join(dir, file))
      expect(typeof spec.idempotent, `${file} must declare idempotent`).toBe("boolean")
    }
  })
})

describe("identifier convention is enforced, not just documented", () => {
  const UUID_V4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479"

  it("rejects a UUIDv4 wherever an identifier is expected (ADR-005)", () => {
    const validIntent = examplesOf(join(SPECS, "Intent.schema.json"))[0] as Record<string, unknown>
    expect(() => Schema.decodeUnknownSync(Intent)({ ...validIntent, id: UUID_V4 })).toThrow()
  })

  it("every identifier in every spec example is a UUIDv7", () => {
    const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    const uuidShaped = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

    const walk = (node: unknown, path: string, offenders: Array<string>): void => {
      if (typeof node === "string") {
        if (uuidShaped.test(node) && !v7.test(node)) offenders.push(`${path} = ${node}`)
        return
      }
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`, offenders))
        return
      }
      if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`, offenders)
      }
    }

    const offenders: Array<string> = []
    for (const file of allSpecFiles(SPECS)) {
      walk(readJson(file), file.slice(SPECS.length + 1), offenders)
    }
    expect(offenders).toEqual([])
  })
})

describe("the identifier convention applies to every spec, not just the ones with code", () => {
  const IDENTIFIER_REF = "https://schema.metis.dev/common/Identifier.schema.json"

  /** Property names that denote an entity identity or a reference to one. */
  const isIdentityField = (name: string): boolean => name === "id" || /^[a-z][A-Za-z0-9]*Id$/.test(name)

  /**
   * The rule is that an identity field must reference a *named* identifier type, not that every id
   * is a UUIDv7. Most are — entities get `Identifier`. Policy rules deliberately do not: their ids
   * are hand-authored slugs like `deny.untrusted_to_agent`, because a rule id appears in decision
   * records a human has to read, and a generated UUID there would be unreadable and unstable.
   *
   * What is banned is a bare `{"type": "string"}`, which commits to nothing and is how the
   * convention quietly erodes.
   */
  it("no spec declares an identity field as a bare string", () => {
    const offenders: Array<string> = []

    for (const file of allSpecFiles(SPECS)) {
      // The shared `common/` primitives define the vocabulary; they are not entities themselves.
      if (file.includes(`${join("specs", "common")}`) || file.includes("/common/")) continue
      // Capability I/O and tool descriptors carry their own domain fields, not METIS entity ids.
      if (file.includes("/capabilities/") || file.includes("/tools/")) continue
      if (file.includes("/conformance/")) continue

      const walk = (node: unknown, path: string): void => {
        if (node === null || typeof node !== "object") return
        if (Array.isArray(node)) {
          node.forEach((item, i) => walk(item, `${path}[${i}]`))
          return
        }

        const record = node as Record<string, unknown>
        const properties = record.properties as Record<string, unknown> | undefined

        if (properties !== undefined) {
          for (const [name, definition] of Object.entries(properties)) {
            if (!isIdentityField(name)) continue
            const declared = definition as Record<string, unknown>
            const ref = declared.$ref

            // Must be a reference to a named identifier type. `Identifier` (UUIDv7) is the norm;
            // a `$defs/*Id` reference is the documented exception for hand-authored ids.
            const namesAnIdentifierType = typeof ref === "string" &&
              (ref === IDENTIFIER_REF || /(^|\/)\$defs\/[A-Za-z0-9]*Id$/.test(ref))

            if (!namesAnIdentifierType) {
              offenders.push(`${file.slice(SPECS.length + 1)}: ${path}.${name} = ${JSON.stringify(declared)}`)
            }
          }
        }

        for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`)
      }

      walk(readJson(file), "")
    }

    expect(offenders).toEqual([])
  })
})

describe("$ref integrity (ADR-004: fail on broken refs)", () => {
  const collectRefs = (node: unknown, acc: Array<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) collectRefs(item, acc)
      return
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") acc.push(value)
        else collectRefs(value, acc)
      }
    }
  }

  it("every $ref resolves to a file that exists", () => {
    const broken: Array<string> = []

    for (const file of allSpecFiles(SPECS)) {
      const refs: Array<string> = []
      collectRefs(readJson(file), refs)

      for (const ref of refs) {
        if (ref.startsWith("#")) continue // local pointer, checked by shape below

        // A ref may carry a fragment naming a definition inside the target file. Both halves are
        // checked: the file must exist, and the definition it names must exist in that file.
        const [location, fragment] = ref.split("#")

        const target = ref.startsWith("https://schema.metis.dev/")
          // Canonical $id space maps onto specs/ by path.
          ? join(SPECS, location!.slice("https://schema.metis.dev/".length))
          // Relative path from the referring file.
          : resolve(file, "..", location!)

        if (!existsSync(target)) {
          broken.push(`${file}: ${ref}`)
          continue
        }

        if (fragment !== undefined && fragment.startsWith("/$defs/")) {
          const defs = (readJson(target).$defs ?? {}) as Record<string, unknown>
          const name = fragment.slice("/$defs/".length)
          if (!(name in defs)) broken.push(`${file}: ${ref} (no such definition in target)`)
        }
      }
    }

    expect(broken).toEqual([])
  })

  it("every local #/$defs pointer names a definition that exists", () => {
    const broken: Array<string> = []

    for (const file of allSpecFiles(SPECS)) {
      const spec = readJson(file)
      const refs: Array<string> = []
      collectRefs(spec, refs)
      const defs = (spec.$defs ?? {}) as Record<string, unknown>

      for (const ref of refs) {
        if (!ref.startsWith("#/$defs/")) continue
        const name = ref.slice("#/$defs/".length)
        if (!(name in defs)) broken.push(`${file}: ${ref}`)
      }
    }

    expect(broken).toEqual([])
  })
})

describe("there is exactly one Artifact", () => {
  it("Plan does not redefine an artifact shape that collides with Artifact.schema.json", () => {
    const plan = readJson(join(SPECS, "Plan.schema.json"))
    const defs = (plan.$defs ?? {}) as Record<string, unknown>

    // The old drift was a second, incompatible `Artifact` living inside the plan. What a plan
    // expects to produce is an ArtifactExpectation and must stay distinctly named.
    expect(Object.keys(defs)).not.toContain("Artifact")
    expect(Object.keys(defs)).toContain("ArtifactExpectation")
  })
})
