#!/usr/bin/env node
/**
 * An MCP server exposing `build.scaffold`: a new project directory, written to disk.
 *
 * The first capability whose effect outlives the call, so its boundary is the workspace:
 *
 * - **It writes only under `METIS_WORKSPACE`,** handed to this process and to no other. Without it
 *   the tool refuses rather than picking a directory of its own.
 * - **The project name is a single path segment** of lowercase letters, digits and hyphens, and
 *   the resolved directory is checked to sit directly inside the workspace. A name shaped by
 *   untrusted content cannot climb out of it.
 * - **It never writes over anything.** The descriptor declares the tool non-idempotent, and a
 *   second call for the same name is refused rather than merged into what is already there. The
 *   directory is created with `recursive: false`, so a race with another writer fails too.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const NAME = /^[a-z][a-z0-9-]{0,62}$/

type Files = Record<string, string>

const nodeTs = (name: string): Files => ({
  "package.json": JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { build: "tsc", start: "node dist/index.js", check: "tsc --noEmit" },
      devDependencies: { typescript: "^5.6.0", "@types/node": "^22.0.0" }
    },
    null,
    2
  ) + "\n",
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        outDir: "dist",
        rootDir: "src",
        skipLibCheck: true
      },
      include: ["src"]
    },
    null,
    2
  ) + "\n",
  "src/index.ts": `export const main = (): string => "${name}"\n\nconsole.log(main())\n`,
  "README.md": `# ${name}\n\n\`\`\`sh\nnpm install\nnpm run build\nnpm start\n\`\`\`\n`,
  ".gitignore": "node_modules/\ndist/\n"
})

const python = (name: string): Files => {
  const pkg = name.replaceAll("-", "_")
  return {
    "pyproject.toml": [
      "[project]",
      `name = "${name}"`,
      `version = "0.1.0"`,
      `requires-python = ">=3.10"`,
      "",
      "[build-system]",
      `requires = ["hatchling"]`,
      `build-backend = "hatchling.build"`,
      "",
      "[tool.hatch.build.targets.wheel]",
      `packages = ["src/${pkg}"]`,
      ""
    ].join("\n"),
    [`src/${pkg}/__init__.py`]: `def main() -> str:\n    return "${name}"\n`,
    "tests/test_smoke.py": `from ${pkg} import main\n\n\ndef test_main() -> None:\n    assert main() == "${name}"\n`,
    "README.md": `# ${name}\n\n\`\`\`sh\npip install -e .\npytest\n\`\`\`\n`,
    ".gitignore": "__pycache__/\n*.egg-info/\n.venv/\ndist/\n"
  }
}

const STACKS: Record<string, (name: string) => Files> = { "node-ts": nodeTs, python }

const refuse = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] })

const server = new McpServer({ name: "metis.build", version: "0.1.0" })

server.registerTool(
  "scaffold",
  {
    title: "Scaffold a project",
    description: `Create a new project directory in the workspace. Stacks: ${Object.keys(STACKS).join(", ")}.`,
    inputSchema: { name: z.string(), stack: z.string().optional() }
  },
  ({ name, stack = "node-ts" }) => {
    const workspace = process.env.METIS_WORKSPACE
    if (workspace === undefined || workspace === "") return refuse("no workspace configured: set METIS_WORKSPACE")

    if (!NAME.test(name)) {
      return refuse(`invalid project name ${JSON.stringify(name)}: lowercase letters, digits and hyphens, at most 63`)
    }
    const files = STACKS[stack]
    if (files === undefined) {
      return refuse(`unknown stack ${JSON.stringify(stack)}: supported are ${Object.keys(STACKS).join(", ")}`)
    }

    const root = resolve(workspace)
    const target = resolve(root, name)
    // The name pattern already rules this out; checked again on the resolved path, which is what
    // actually gets written.
    if (relative(root, target) !== name) return refuse(`${JSON.stringify(name)} resolves outside the workspace`)

    try {
      mkdirSync(root, { recursive: true })
      mkdirSync(target, { recursive: false })
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      return refuse(code === "EEXIST" ? `${name} already exists in the workspace` : `cannot create ${name}: ${code}`)
    }

    const written = Object.entries(files(name))
    try {
      for (const [file, content] of written) {
        const path = join(target, ...file.split("/"))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content, { flag: "wx" })
      }
    } catch (cause) {
      // Half a project is worse than none: the directory was ours a moment ago, so it goes.
      rmSync(target, { recursive: true, force: true })
      return refuse(`scaffolding ${name} failed: ${String(cause)}`)
    }

    const markdown = [
      `# ${name}`,
      "",
      `Scaffolded a \`${stack}\` project at \`${target}${sep}\`:`,
      "",
      ...written.map(([file]) => `- \`${file}\``),
      ""
    ].join("\n")
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ markdown }) }],
      structuredContent: { markdown }
    }
  }
)

await server.connect(new StdioServerTransport())
