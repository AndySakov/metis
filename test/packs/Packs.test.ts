import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Either, Schema } from "effect"

import { Intent } from "../../src/domain/Intent.js"
import * as Planner from "../../src/orchestrator/Planner.js"
import * as Packs from "../../src/packs/Packs.js"

/**
 * Loading a pack: what it may declare, and what stops METIS rather than loading in part. The
 * redact pack in the repository is the one that must load; each refusal is a copy of it with one
 * thing wrong.
 */

const REDACT = resolve(__dirname, "../../packs/redact")
const scratch = mkdtempSync(join(tmpdir(), "metis-packs-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const manifest = JSON.parse(readFileSync(join(REDACT, "pack.json"), "utf8"))

/** A copy of the redact pack, with its manifest changed by `change`. */
const variant = (name: string, change: (pack: any) => any): string => {
  const dir = join(scratch, name)
  cpSync(REDACT, dir, { recursive: true })
  writeFileSync(join(dir, "pack.json"), JSON.stringify(change(structuredClone(manifest))))
  return dir
}

const refusal = async (dirs: ReadonlyArray<string>): Promise<string> => {
  const result = await Effect.runPromise(Effect.either(Packs.loadAll(dirs)))
  if (Either.isRight(result)) throw new Error("expected the packs to be refused")
  return result.left.message
}

describe("a pack that loads", () => {
  it("brings its servers, its descriptors with their schemas resolved, and its templates", async () => {
    const [pack] = await Effect.runPromise(Packs.loadAll([REDACT]))
    expect(pack!.manifest.name).toBe("redact")
    // `node` is the Node running METIS; `${pack}` is the pack's own directory.
    expect(pack!.servers["redact.tools"]).toEqual({
      command: process.execPath,
      args: ["--experimental-strip-types", `${REDACT}/src/server.ts`],
      env: {}
    })
    const [tool] = pack!.tools
    expect(tool!.capability).toBe("text.redact@0.1")
    expect(tool!.outputSchema!.required).toEqual(["text", "found", "markdown"])
    expect(pack!.templates.map((t) => t.name)).toEqual(["redact"])
  })

  it("hands a server the variables it names, and no others, resolving the ones that are paths", async () => {
    const dir = variant("env", (pack) => {
      pack.servers["redact.tools"].env = ["REDACT_SETTING", "REDACT_FILE", "REDACT_UNSET"]
      pack.servers["redact.tools"].paths = ["REDACT_FILE"]
      return pack
    })
    const saved = { ...process.env }
    process.env.REDACT_SETTING = "on"
    process.env.REDACT_FILE = "relative/rules.json"
    process.env.UNRELATED_SECRET = "never"
    try {
      const [pack] = await Effect.runPromise(Packs.loadAll([dir]))
      expect(pack!.servers["redact.tools"]!.env).toEqual({
        REDACT_SETTING: "on",
        REDACT_FILE: join(process.cwd(), "relative/rules.json")
      })
    } finally {
      process.env = saved
    }
  })
})

describe("a pack that is refused", () => {
  it("is not a pack without a pack.json", async () => {
    expect(await refusal([scratch])).toContain("no pack.json")
  })

  it("may not name a server in core's namespace", async () => {
    const dir = variant("core-name", (pack) => ({ ...pack, servers: { "metis.design": pack.servers["redact.tools"] } }))
    expect(await refusal([dir])).toContain("not a valid pack")
  })

  it("may not bind a tool on a server it does not run", async () => {
    const dir = variant("foreign", (pack) => ({
      ...pack,
      servers: { "redact.other": pack.servers["redact.tools"] }
    }))
    expect(await refusal([dir])).toContain("binds redact.tools, which this pack does not run")
  })

  it("may not reuse a server name another pack has taken", async () => {
    const other = variant("other", (pack) => ({ ...pack, name: "other" }))
    expect(await refusal([REDACT, other])).toContain("server redact.tools is already pack redact's")
  })

  it("may not load twice under one name", async () => {
    expect(await refusal([REDACT, REDACT])).toContain("a pack named redact is already loaded")
  })

  it("may not point outside its own directory", async () => {
    const dir = variant("escape", (pack) => ({ ...pack, tools: ["../redact/tools/text.redact.tool.json"] }))
    expect(await refusal([dir])).toContain("not a valid pack")
  })

  it("may not let a server use the model without its tools declaring it", async () => {
    const dir = variant("model", (pack) => {
      pack.servers["redact.tools"].model = true
      return pack
    })
    expect(await refusal([dir])).toContain("which may use the model, so it must declare the model.sample scope")
  })

  it("may not carry a template whose pattern does not compile", async () => {
    const dir = variant("regex", (pack) => {
      pack.templates[0].match = "(unclosed"
      return pack
    })
    expect(await refusal([dir])).toContain("not a regular expression")
  })
})

describe("a pack's templates, compiled", () => {
  const intent = (goal: string, pasted?: string) =>
    Schema.decodeUnknownSync(Intent)({
      id: "01890a5d-ac96-774b-bcce-b302099a8057",
      ts: 1735872000,
      actor: "user:andysakov",
      goal,
      autonomy: "S2",
      inputs: pasted === undefined ? [] : [{ name: "pasted", value: pasted, tags: ["untrusted", "pasted"] }]
    })
  const plan = (goal: string, pasted?: string) =>
    Effect.runPromise(
      Effect.flatMap(Effect.map(Packs.loadAll([REDACT]), (packs) => Planner.makeFor(() => true, packs[0]!.templates)), (
        planner
      ) => planner.plan(intent(goal, pasted)))
    )

  it("fill a step's input from what was pasted", async () => {
    const planned = await plan("Redact the personal details in this", "Call 0712345678")
    expect(planned.steps.map((s) => s.toolCall)).toEqual([
      expect.objectContaining({ capability: "text.redact@0.1", input: { text: "Call 0712345678" } })
    ])
    expect(planned.risks.map((r) => r.description)).toContain(
      "Only the kinds of detail listed are found: names and addresses are not"
    )
  })

  it("ask for the paste a template needs, rather than run on nothing", async () => {
    const planned = await plan("Scrub this for me")
    expect(planned.steps.map((s) => [s.kind, s.description])).toEqual([["ask", "Paste the text to redact"]])
  })

  it("come after core's specific templates and before its broad ones", async () => {
    // A document goal stays a document, even when it mentions redacting.
    expect((await plan("Draft a PRD for a redaction service")).steps.at(-1)!.toolCall!.capability).toBe(
      "design.prd@1.0"
    )
    // And a pack's goal is not taken by research.
    expect(Planner.templateFor("Research how to redact logs", []).name).toBe("research")
    const [pack] = await Effect.runPromise(Packs.loadAll([REDACT]))
    expect(Planner.templateFor("Compare ways to redact this", pack!.templates).name).toBe("redact")
  })
})
