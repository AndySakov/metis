import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ToolSpec } from "../../src/domain/ToolSpec.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/**
 * `build.scaffold`, over MCP, against a real directory.
 *
 * The first tool whose effect outlives the call. Most of this file is about where it may write:
 * only inside the workspace it was handed, never over something already there.
 */

const spec = Schema.decodeUnknownSync(ToolSpec)(
  JSON.parse(readFileSync(resolve(__dirname, "../../specs/tools/examples/build.scaffold.tool.json"), "utf8"))
)

const scratch = mkdtempSync(join(tmpdir(), "metis-build-"))
const workspace = join(scratch, "workspace")
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const server = (env?: Record<string, string>): McpToolRunner.ServerMap => ({
  "metis.build": {
    command: "node",
    args: ["--experimental-strip-types", resolve(__dirname, "../../src/tools/servers/build.ts")],
    ...(env !== undefined ? { env } : {})
  }
})

const call = (input: Record<string, unknown>, servers = server({ METIS_WORKSPACE: workspace })) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const runner = yield* ToolRunner
        return yield* Effect.either(runner.run(spec, input))
      })
    ).pipe(Effect.provide(McpToolRunner.layer(servers))) as Effect.Effect<any>
  )

/** Every file under `dir`, relative and sorted. */
const tree = (dir: string, prefix = ""): Array<string> =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? tree(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`]
    )
    .sort()

describe("build.scaffold writes a project", () => {
  it("defaults to node-ts, and the package is named for the project", async () => {
    const outcome = await call({ name: "notes-api" })
    expect(outcome._tag).toBe("Right")

    const dir = join(workspace, "notes-api")
    expect(tree(dir)).toEqual([".gitignore", "README.md", "package.json", "src/index.ts", "tsconfig.json"])
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("notes-api")
    expect(outcome.right.output.markdown).toContain("`src/index.ts`")
  }, 30_000)

  it("writes a python package whose import name is the project name with underscores", async () => {
    const outcome = await call({ name: "data-tool", stack: "python" })
    expect(outcome._tag).toBe("Right")

    const dir = join(workspace, "data-tool")
    expect(tree(dir)).toEqual([
      ".gitignore",
      "README.md",
      "pyproject.toml",
      "src/data_tool/__init__.py",
      "tests/test_smoke.py"
    ])
    expect(readFileSync(join(dir, "tests/test_smoke.py"), "utf8")).toContain("from data_tool import main")
  }, 30_000)
})

describe("build.scaffold stays inside its workspace", () => {
  it("refuses a name that is not a single safe path segment", async () => {
    for (const name of ["../escape", "a/b", "/etc", "Upper", "-leading", "", "x".repeat(64), "dot.name"]) {
      const outcome = await call({ name })
      expect(outcome._tag, `${JSON.stringify(name)} must be refused`).toBe("Left")
    }
    expect(existsSync(join(scratch, "escape"))).toBe(false)
  }, 60_000)

  it("never writes over an existing directory, and leaves what is there alone", async () => {
    const dir = join(workspace, "taken")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "README.md"), "mine")

    const outcome = await call({ name: "taken" })
    expect(outcome._tag).toBe("Left")
    expect(String(outcome.left.message)).toContain("already exists")
    expect(tree(dir)).toEqual(["README.md"])
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("mine")
  }, 30_000)

  it("refuses a second scaffold of the same name: the tool is not idempotent, and says so", async () => {
    expect((await call({ name: "twice" }))._tag).toBe("Right")
    expect((await call({ name: "twice" }))._tag).toBe("Left")
  }, 30_000)

  it("names the supported stacks when asked for one it does not have", async () => {
    const outcome = await call({ name: "rusty", stack: "rust" })
    expect(outcome._tag).toBe("Left")
    expect(String(outcome.left.message)).toContain("node-ts, python")
    expect(existsSync(join(workspace, "rusty"))).toBe(false)
  }, 30_000)

  it("writes nothing without a workspace rather than choosing a directory itself", async () => {
    const outcome = await call({ name: "nowhere" }, server())
    expect(outcome._tag).toBe("Left")
    expect(String(outcome.left.message)).toContain("METIS_WORKSPACE")
  }, 30_000)
})
