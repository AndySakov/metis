/**
 * Model CLIs: any command-line program that takes a prompt and prints an answer, used as the model
 * behind the `design.*` capabilities.
 *
 * This is how METIS runs on a subscription rather than an API key: `claude -p` signed in to Claude
 * Code, `codex exec` signed in to ChatGPT, a local `ollama`, or anything else that reads a prompt
 * and writes text. Each preset says how to call its program, how to read its answer, which
 * environment variables carry its credentials, and, plainly, whether the program keeps tools of its
 * own while it answers. `metis.model`'s guarantee is that the model has none; a CLI agent that
 * cannot be told to put its tools down breaks that guarantee, and startup says so.
 *
 * Kept free of Node APIs, so the model server can import it under Node's type stripping as well as
 * the composition root under the compiler.
 */

/**
 * What the program can do besides answer.
 *
 * - `off`: it has tools and METIS switches them all off.
 * - `none`: it is a plain model call with no tools to switch off.
 * - `sandboxed`: its tools stay on inside the program's own sandbox.
 * - `unconfirmed`: its tools stay on, limited by its own approval rules.
 * - `unknown`: a custom command; METIS cannot tell.
 */
export type ToolPosture = "off" | "none" | "sandboxed" | "unconfirmed" | "unknown"

/** A posture under which the model gets no tools: the only ones `metis.model` itself would accept. */
export const toolless = (posture: ToolPosture): boolean => posture === "off" || posture === "none"

export interface Invocation {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** Written to the program's standard input, then closed. */
  readonly stdin: string
}

export type Answer = { readonly text: string } | { readonly error: string }

export interface ModelCli {
  readonly name: string
  readonly tools: ToolPosture
  /** What the posture means for this program, in a sentence, for the startup log. */
  readonly toolsNote: string
  /** Environment variables the program reads for credentials or configuration. */
  readonly env: ReadonlyArray<string>
  readonly requiresModel: boolean
  readonly invoke: (system: string, prompt: string, model: string | undefined) => Invocation
  readonly parse: (stdout: string) => Answer
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** Plain stdout as the answer, with terminal colouring removed. */
const plainText = (stdout: string): Answer => {
  const text = stdout.replace(ANSI, "").trim()
  return text === "" ? { error: "the model CLI printed nothing" } : { text }
}

const asJson = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** System prompt and request in one text, for programs that take no separate system prompt. */
const combined = (system: string, prompt: string): string => `${system}\n\n${prompt}`

const modelArgs = (flag: string, model: string | undefined): ReadonlyArray<string> =>
  model === undefined ? [] : [flag, model]

export const PRESETS: Readonly<Record<string, ModelCli>> = {
  claude: {
    name: "claude",
    tools: "off",
    toolsNote: "Claude Code runs with every tool, MCP server, setting and slash command switched off.",
    // Not ANTHROPIC_API_KEY: given one, Claude Code bills the API instead of the signed-in plan.
    env: ["CLAUDE_CONFIG_DIR"],
    requiresModel: false,
    invoke: (system, prompt, model) => ({
      command: "claude",
      args: [
        "-p",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--system-prompt",
        system,
        ...modelArgs("--model", model)
      ],
      stdin: prompt
    }),
    parse: (stdout) => {
      const result = asJson(stdout)
      if (result === undefined) return { error: "claude printed something other than its JSON result" }
      if (result.is_error === true) {
        return { error: `claude reported an error: ${String(result.result ?? result.subtype)}` }
      }
      if (result.stop_reason === "refusal") return { error: "the model declined" }
      // A truncated document must not be stored as if it were whole.
      if (result.stop_reason === "max_tokens") return { error: "the model stopped early (max_tokens)" }
      return typeof result.result === "string" ? plainText(result.result) : { error: "claude returned no text" }
    }
  },
  codex: {
    name: "codex",
    tools: "sandboxed",
    toolsNote: "Codex keeps its shell, in its read-only sandbox: it can read files it can reach, not change them.",
    env: ["OPENAI_API_KEY", "CODEX_HOME"],
    requiresModel: false,
    invoke: (system, prompt, model) => ({
      command: "codex",
      // `-` reads the prompt from stdin; only the final message goes to stdout.
      args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", ...modelArgs("-m", model), "-"],
      stdin: combined(system, prompt)
    }),
    parse: plainText
  },
  gemini: {
    name: "gemini",
    tools: "unconfirmed",
    toolsNote: "Gemini CLI refuses tools that would ask for approval when headless; read-only ones may still run.",
    env: [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_APPLICATION_CREDENTIALS"
    ],
    requiresModel: false,
    invoke: (system, prompt, model) => ({
      command: "gemini",
      args: ["--output-format", "json", ...modelArgs("-m", model), "-p", combined(system, prompt)],
      stdin: ""
    }),
    parse: (stdout) => {
      const result = asJson(stdout)
      if (result === undefined) return { error: "gemini printed something other than its JSON result" }
      if (result.error !== undefined && result.error !== null) {
        return { error: `gemini reported an error: ${JSON.stringify(result.error)}` }
      }
      return typeof result.response === "string" ? plainText(result.response) : { error: "gemini returned no text" }
    }
  },
  ollama: {
    name: "ollama",
    tools: "none",
    toolsNote: "ollama run is a plain model call.",
    env: ["OLLAMA_HOST"],
    requiresModel: true,
    invoke: (system, prompt, model) => ({
      command: "ollama",
      args: ["run", model ?? ""],
      stdin: combined(system, prompt)
    }),
    parse: plainText
  },
  llm: {
    name: "llm",
    tools: "none",
    toolsNote: "llm uses tools only when given them, which METIS never does.",
    env: ["LLM_USER_PATH"],
    requiresModel: false,
    invoke: (system, prompt, model) => ({
      command: "llm",
      args: ["-s", system, ...modelArgs("-m", model)],
      stdin: prompt
    }),
    parse: plainText
  }
}

/**
 * A command of your own, as a JSON array: `["my-model", "--quiet"]`. It gets the whole prompt on
 * stdin and its stdout is the answer. `{model}` in an argument is replaced by the configured model.
 */
const custom = (argv: ReadonlyArray<string>): ModelCli => ({
  name: argv[0]!,
  tools: "unknown",
  toolsNote: "A custom command: METIS cannot tell whether it has tools.",
  env: [],
  requiresModel: argv.some((arg) => arg.includes("{model}")),
  invoke: (system, prompt, model) => ({
    command: argv[0]!,
    args: argv.slice(1).map((arg) => arg.replaceAll("{model}", model ?? "")),
    stdin: combined(system, prompt)
  }),
  parse: plainText
})

/** The CLI `METIS_MODEL_CLI` names: a preset, or a JSON array for a command of your own. */
export const resolve = (spec: string): ModelCli | { readonly error: string } => {
  const preset = PRESETS[spec.trim()]
  if (preset !== undefined) return preset
  if (spec.trim().startsWith("[")) {
    let argv: unknown
    try {
      argv = JSON.parse(spec)
    } catch {
      return { error: `METIS_MODEL_CLI is not valid JSON: ${spec}` }
    }
    if (Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string") && argv[0] !== "") {
      return custom(argv as Array<string>)
    }
    return { error: "METIS_MODEL_CLI as JSON must be a non-empty array of strings: the command and its arguments" }
  }
  return {
    error: `unknown model CLI "${spec}": use one of ${
      Object.keys(PRESETS).join(", ")
    }, or a JSON array for your own command`
  }
}
