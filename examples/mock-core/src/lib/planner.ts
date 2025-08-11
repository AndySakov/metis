import { createLogger } from "./logger.js";
const log = createLogger("planner");

// Robust prompt construction for higher reliability
const RESPONSE_SPEC = `
Respond with STRICT JSON only, matching this TypeScript shape:
{
  "id": string,
  "intentId": string,
  "steps": Array<{
    "id": string,
    "kind": "tool" | "ask" | "write" | "decision",
    "description": string,
    "requiresApproval"?: boolean,
    "toolCall"?: {
      "capability": string, // one of AVAILABLE_CAPABILITIES
      "input": object
    }
  }>,
  "assumptions": string[],
  "risks": string[],
  "expectedArtifacts": string[]
}

If the goal cannot be achieved with AVAILABLE_CAPABILITIES, respond instead with:
{ "unachievable": true, "reason": string }
`;

function buildToolHints(tools: any[]): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const lines: string[] = [];
  for (const t of tools) {
    const cap = t?.capability ?? "";
    const name = t?.name ?? "";
    const inputRef =
      t?.inputSchema?.$ref ||
      (typeof t?.inputSchema === "string" ? t.inputSchema : "");
    const outputRef =
      t?.outputSchema?.$ref ||
      (typeof t?.outputSchema === "string" ? t.outputSchema : "");
    const sample =
      Array.isArray(t?.tests) && t.tests[0]?.input
        ? JSON.stringify(t.tests[0].input)
        : undefined;
    const parts = [
      `- ${cap}${name ? ` (${name})` : ""}`,
      inputRef ? `  input: ${inputRef}` : undefined,
      outputRef ? `  output: ${outputRef}` : undefined,
      sample ? `  example input: ${sample}` : undefined,
    ].filter(Boolean);
    lines.push(parts.join("\n"));
  }
  return lines.join("\n");
}

const FEW_SHOTS = `
Examples (for illustration; do NOT copy IDs):

Goal: Draft a PRD for the Widget v1
Plan:
{
  "id": "plan_temp_1",
  "intentId": "intent_temp_1",
  "steps": [
    {
      "id": "step_temp_prd",
      "kind": "tool",
      "description": "Generate PRD markdown",
      "toolCall": { "capability": "design.prd@1.0", "input": { "title": "Widget v1 PRD" } }
    }
  ],
  "assumptions": ["Title is sufficient to scaffold PRD"],
  "risks": ["PRD is generic if requirements are sparse"],
  "expectedArtifacts": ["markdown"]
}

Goal: Summarize search results into a brief report
Plan:
{
  "id": "plan_temp_2",
  "intentId": "intent_temp_2",
  "steps": [
    {
      "id": "step_search",
      "kind": "tool",
      "description": "Search the web",
      "toolCall": { "capability": "research.search@0.1", "input": { "query": "retrieval augmented generation", "limit": 3 } }
    },
    {
      "id": "step_summarize",
      "kind": "tool",
      "description": "Summarize snippets",
      "toolCall": { "capability": "research.summarize@0.1", "input": { "chunks": [{"text": "<paste results here>"}] } }
    }
  ],
  "assumptions": ["Public sources are sufficient"],
  "risks": ["Potential hallucinations in sources"],
  "expectedArtifacts": ["markdown"]
}
`;

function SYSTEM_PROMPT(capsList: string, toolHints: string) {
  return [
    `You are METIS's planning brain. Your job is to synthesize a small, executable plan DAG that uses available capabilities to achieve the user's goal.`,
    `AVAILABLE_CAPABILITIES: ${capsList}.`,
    toolHints ? `AVAILABLE_TOOLS:\n${toolHints}` : "",
    `Rules:`,
    `- Use ONLY capabilities listed in AVAILABLE_CAPABILITIES.`,
    `- Think step-by-step and verify feasibility for each step with the provided input/output schemas.`,
    `- Each tool step must include toolCall.capability and a minimal valid input.`,
    `- Keep plans minimal (1-5 steps) and executable end-to-end.`,
    `- Prefer "design.prd@1.0" for PRD generation when appropriate.`,
    `- Do not invent tools or capabilities.`,
    `- If the goal is not possible with available tools, respond with {unachievable:true}.`,
    `- Output JSON ONLY. No markdown, no prose.`,
    `- Include assumptions, risks, and expectedArtifacts.`,
    `- Use transform.extract@0.1, graph.link@0.1, vector.upsert@0.1 when appropriate for extraction, linking, and vectorization tasks.`,
    `Response Contract:`,
    RESPONSE_SPEC,
    `\n${FEW_SHOTS}`,
  ].join("\n");
}

function USER_PROMPT(goal: string) {
  return [
    `Goal: ${goal}`,
    `Requirements:`,
    `- Produce a minimal, valid plan that can be executed with the listed capabilities.`,
    `- Verify each step is feasible with AVAILABLE_CAPABILITIES (no imaginary tools).`,
    `- Include assumptions, risks, and expectedArtifacts.`,
    `- If PRD is requested, include a tool step using design.prd@1.0 with an appropriate title input.`,
    `- If the plan requires fetching, summarizing, transforming, or linking data, use research.* tools, transform.extract@0.1, graph.link@0.1, and vector.upsert@0.1 as appropriate.`,
    `- Keep steps independent unless strictly required; avoid unnecessary branches.`,
    `Return JSON only.`,
  ].join("\n");
}

export async function planWithOpenAI(goal: string, tools: any[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const caps = Array.isArray(tools)
    ? tools.map((t: any) => t.capability).filter(Boolean)
    : [];
  const capsList = caps.join(", ");
  const toolHints = buildToolHints(Array.isArray(tools) ? tools : []);
  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4o",
    temperature: process.env.OPENAI_TEMPERATURE
      ? Number(process.env.OPENAI_TEMPERATURE)
      : 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT(capsList, toolHints) },
      { role: "user", content: USER_PROMPT(goal) },
    ],
    response_format: { type: "json_object" },
  } as const;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`openai ${r.status}`);
  const data: any = await r.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(content);
    log.info("openai_plan_ok", {
      steps: Array.isArray(parsed?.steps) ? parsed.steps.length : 0,
    });
    return parsed;
  } catch (e: any) {
    log.error("openai_plan_parse_error", {
      error: String(e?.message || e),
      snippet: String(content).slice(0, 200),
    });
    return {};
  }
}

export async function planWithOllama(goal: string, tools: any[]) {
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const model = process.env.OLLAMA_MODEL || "llama3.1:8b";
  const caps = Array.isArray(tools)
    ? tools.map((t: any) => t.capability).filter(Boolean)
    : [];
  const capsList = caps.join(", ");
  const toolHints = buildToolHints(Array.isArray(tools) ? tools : []);
  const body = {
    model,
    stream: false,
    format: "json",
    options: {
      temperature: process.env.OLLAMA_TEMPERATURE
        ? Number(process.env.OLLAMA_TEMPERATURE)
        : 0.2,
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT(capsList, toolHints) },
      { role: "user", content: USER_PROMPT(goal) },
    ],
  } as const;
  const r = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const data: any = await r.json();
  const content = data?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(content);
    log.info("ollama_plan_ok", {
      steps: Array.isArray(parsed?.steps) ? parsed.steps.length : 0,
    });
    return parsed;
  } catch (e: any) {
    log.error("ollama_plan_parse_error", {
      error: String(e?.message || e),
      snippet: String(content).slice(0, 200),
    });
    return {};
  }
}
