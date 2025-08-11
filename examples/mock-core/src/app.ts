import express from "express";
import cors from "cors";
import {
  artifacts,
  eventlog,
  plans,
  newId,
  toEpoch,
  vectors,
  graph,
  approvals,
  getPolicy,
  setPolicy,
} from "./stores.js";
import { executePlanWithTools, runTool } from "./lib/execute.js";
import type { Intent, Plan } from "./types.js";
import { loadToolSpecs } from "./lib/tools.js";
import { planWithOpenAI, planWithOllama } from "./lib/planner.js";
import { createLogger } from "./lib/logger.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateToolSpec as validateToolSpecShared } from "./lib/validator.js";

export const app = express();
const log = createLogger("app");
app.use(cors());
app.use(express.json());
// Request logger middleware
app.use((req, res, next) => {
  const requestStartMs = Date.now();
  const { method, originalUrl } = req;
  const clientIp =
    (req.headers["x-forwarded-for"] as string) ||
    req.socket.remoteAddress ||
    "";
  res.on("finish", () => {
    const durationMs = Date.now() - requestStartMs;
    const { statusCode } = res;
    log.info("http_request", {
      ip: clientIp,
      method,
      path: originalUrl,
      status: statusCode,
      durationMs,
    });
  });
  next();
});

app.get("/tools", async (_req, res) => {
  log.debug("tools_list_begin");
  const specs = await loadToolSpecs();
  log.info("tools_list_complete", { count: specs.length });
  res.json(specs);
});

// Validate a ToolSpec against schema references and run shape-only tests
app.post("/tools/validate", async (req, res) => {
  try {
    const spec = req.body ?? {};
    const report = await validateToolSpecShared(spec);
    res.json(report);
  } catch (e: any) {
    res.status(400).json({ valid: false, errors: [String(e?.message || e)] });
  }
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../");

async function derefMaybe(schema: any): Promise<any> {
  if (!schema) return undefined;
  if (typeof schema === "string") {
    try {
      const filePath = resolve(
        repoRoot,
        "specs",
        schema.replace(/^\.\.\//, "")
      );
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (schema.$ref && typeof schema.$ref === "string") {
    try {
      const filePath = resolve(
        repoRoot,
        "specs",
        schema.$ref.replace(/^\.\.\//, "")
      );
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {}
  }
  return schema;
}

app.post("/intent", async (req, res) => {
  const intent = req.body as Intent;
  const planId = newId("plan");
  log.info("intent_received", {
    intentId: intent.id,
    planId,
    goal: intent.goal,
  });
  const steps = (intent.goal ?? "").toLowerCase().includes("prd")
    ? [
        {
          id: newId("step"),
          kind: "tool" as const,
          description: "Generate PRD markdown",
          toolCall: {
            capability: "design.prd@1.0",
            tool: "design.prd",
            input: { title: intent.goal },
          },
        },
      ]
    : [];
  const plan: Plan = {
    id: planId,
    intentId: intent.id,
    project: intent.project,
    steps,
    assumptions: [],
    risks: [],
    expectedArtifacts: ["markdown"],
  };
  plans.set(planId, plan);
  log.info("plan_created", { planId, steps: plan.steps.length });
  await eventlog.put({
    id: newId("evt"),
    ts: toEpoch(Date.now()),
    type: "PLAN_CREATED",
    actor: "metis",
    payload: { planId },
    project: intent.project,
  });
  res.status(201).json(plan);
});

app.get("/plans/:id", async (req, res) => {
  log.debug("plan_get", { planId: req.params.id });
  const plan = plans.get(req.params.id);
  if (!plan) return res.status(404).send("plan not found");
  res.json(plan);
});

// Plan step status derived from events
app.get("/plans/:id/status", async (req, res) => {
  const plan = plans.get(req.params.id);
  if (!plan) return res.status(404).send("plan not found");
  const evts = await eventlog.list({});
  const byStep = new Map<
    string,
    { stepId: string; status: string; ts: number }
  >();
  for (const e of evts) {
    const p: any = (e as any).payload || {};
    if (p.planId !== plan.id) continue;
    if (e.type === "STEP_REJECTED" && p.stepId) {
      byStep.set(p.stepId, {
        stepId: p.stepId,
        status: "failed",
        ts: e.ts,
      });
    }
    if (e.type === "APPROVAL_REQUIRED" && p.stepId) {
      byStep.set(p.stepId, {
        stepId: p.stepId,
        status: "awaiting_approval",
        ts: e.ts,
      });
    }
    if (e.type === "APPROVAL_DECIDED" && p.stepId) {
      byStep.set(p.stepId, {
        stepId: p.stepId,
        status: p.verdict === "granted" ? "approved" : "denied",
        ts: e.ts,
      });
    }
    if (e.type === "STEP_SKIPPED" && p.stepId) {
      byStep.set(p.stepId, { stepId: p.stepId, status: "skipped", ts: e.ts });
    }
    if (e.type === "TOOL_STARTED" && p.stepId) {
      byStep.set(p.stepId, { stepId: p.stepId, status: "running", ts: e.ts });
    }
    if (e.type === "TOOL_FAILED" && p.stepId) {
      byStep.set(p.stepId, { stepId: p.stepId, status: "failed", ts: e.ts });
    }
    if (e.type === "TOOL_COMPLETED" && p.stepId) {
      const cur = byStep.get(p.stepId);
      byStep.set(p.stepId, {
        stepId: p.stepId,
        status: p.status || "completed",
        ts: e.ts,
      });
    }
  }
  // default unknown steps to pending
  for (const s of plan.steps) {
    if (!byStep.has(s.id))
      byStep.set(s.id, { stepId: s.id, status: "pending", ts: 0 });
  }
  res.json(Array.from(byStep.values()));
});

// List all plans (in-memory)
app.get("/plans", async (_req, res) => {
  const project = _req.query.project ? String(_req.query.project) : undefined;
  const all = Array.from(plans.values()).filter(
    (p) => !project || p.project === project
  );
  log.info("plans_list", { count: all.length });
  res.json(all);
});

app.post("/plans/:id/execute", async (req, res) => {
  const plan = plans.get(req.params.id) as Plan;
  if (!plan) return res.status(404).send("plan not found");
  const executionId = newId("exec");
  // Run in background so client can observe via events
  (async () => {
    const startedAt = new Date();
    await eventlog.put({
      id: newId("evt"),
      ts: toEpoch(Date.now()),
      type: "EXECUTION_STARTED",
      actor: "metis",
      payload: { planId: plan.id, executionId },
      project: plan.project,
    });
    log.info("plan_execute_start", {
      planId: plan.id,
      steps: plan.steps.length,
      executionId,
    });
    try {
      const stepResults = await executePlanWithTools(plan);
      await eventlog.put({
        id: newId("evt"),
        ts: toEpoch(Date.now()),
        type: "EXECUTION_COMPLETED",
        actor: "metis",
        payload: {
          planId: plan.id,
          executionId,
          status: "completed",
          durationMs: Date.now() - startedAt.getTime(),
          stepResultsCount: stepResults.length,
        },
        project: plan.project,
      });
      log.info("plan_execute_complete", {
        planId: plan.id,
        durationMs: Date.now() - startedAt.getTime(),
        executionId,
      });
    } catch (e: any) {
      await eventlog.put({
        id: newId("evt"),
        ts: toEpoch(Date.now()),
        type: "EXECUTION_COMPLETED",
        actor: "metis",
        payload: {
          planId: plan.id,
          executionId,
          status: "failed",
          error: String(e?.message || e),
        },
        project: plan.project,
      });
      log.error("plan_execute_failed", {
        planId: plan.id,
        executionId,
        error: String(e?.message || e),
      });
    }
  })();
  res.status(202).json({ planId: plan.id, executionId, status: "started" });
});

app.get("/artifacts/:id", async (req, res) => {
  try {
    log.debug("artifact_head", { artifactId: req.params.id });
    const meta = await artifacts.head(req.params.id);
    res.json(meta);
  } catch {
    log.warn("artifact_missing", { artifactId: req.params.id });
    res.status(404).send("artifact not found");
  }
});

// Optional: serve raw artifact content (for markdown preview or download)
app.get("/artifacts/:id/content", async (req, res) => {
  try {
    const meta = await artifacts.head(req.params.id);
    const bytes = await artifacts.get(req.params.id);
    res.setHeader(
      "content-type",
      meta.kind === "markdown"
        ? "text/markdown; charset=utf-8"
        : "application/octet-stream"
    );
    res.send(Buffer.from(bytes));
  } catch {
    res.status(404).send("artifact not found");
  }
});

app.get("/eventlog", async (req, res) => {
  const fromTs = req.query.fromTs ? Number(req.query.fromTs) : undefined;
  const toTs = req.query.toTs ? Number(req.query.toTs) : undefined;
  const types = Array.isArray(req.query.types)
    ? (req.query.types as string[])
    : req.query.types
    ? [String(req.query.types)]
    : undefined;
  const project = req.query.project ? String(req.query.project) : undefined;
  const events = await eventlog.list({ fromTs, toTs, types, project });
  log.info("eventlog_list", { count: events.length });
  res.json(events);
});

// Projects list (derived)
app.get("/projects", async (_req, res) => {
  const set = new Set<string>();
  for (const p of plans.values()) {
    if (p.project) set.add(String(p.project));
  }
  const allEvents = await eventlog.list({});
  for (const e of allEvents) {
    const proj = (e as any).project;
    if (proj) set.add(String(proj));
  }
  const list = Array.from(set.values()).sort();
  res.json(list);
});

// Server-Sent Events stream for live events
app.get("/events/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const unsubscribe = eventlog.subscribe((e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  req.on("close", () => {
    unsubscribe();
  });
});

// Execution trail for a plan (ordered by time, limited)
app.get("/plans/:id/trail", async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const project = req.query.project ? String(req.query.project) : undefined;
  const all = await eventlog.list({ project });
  const filtered = all
    .filter((e: any) => {
      const p = e?.payload || {};
      return (
        p.planId === req.params.id ||
        (e.type === "ARTIFACT_WRITTEN" && p.planId === req.params.id)
      );
    })
    .sort((a: any, b: any) => a.ts - b.ts);
  res.json(filtered.slice(-limit));
});

// Plan artifacts
app.get("/plans/:id/artifacts", async (req, res) => {
  const plan = plans.get(req.params.id);
  if (!plan) return res.status(404).send("plan not found");
  const evts = await eventlog.list({});
  const ids = evts
    .filter(
      (e: any) => e.type === "ARTIFACT_WRITTEN" && e.payload?.planId === plan.id
    )
    .map((e: any) => e.payload.artifactId);
  const metas = await Promise.all(
    ids.map(async (id: string) => {
      try {
        return await artifacts.head(id);
      } catch {
        return null;
      }
    })
  );
  res.json(metas.filter(Boolean));
});

// Approvals endpoints
app.post("/plans/:id/approve/:stepId", async (req, res) => {
  const plan = plans.get(req.params.id);
  if (!plan) return res.status(404).send("plan not found");
  approvals.approve(req.params.id, req.params.stepId, true);
  await eventlog.put({
    id: newId("evt"),
    ts: toEpoch(Date.now()),
    type: "APPROVAL_GRANTED",
    actor: "metis",
    payload: { planId: req.params.id, stepId: req.params.stepId },
    project: plan.project,
  });
  res.json({ ok: true });
});
app.post("/plans/:id/deny/:stepId", async (req, res) => {
  const plan = plans.get(req.params.id);
  if (!plan) return res.status(404).send("plan not found");
  approvals.approve(req.params.id, req.params.stepId, false);
  await eventlog.put({
    id: newId("evt"),
    ts: toEpoch(Date.now()),
    type: "APPROVAL_DENIED",
    actor: "metis",
    payload: { planId: req.params.id, stepId: req.params.stepId },
    project: plan.project,
  });
  res.json({ ok: true });
});

// Vector search API
app.post("/vectors/search", async (req, res) => {
  try {
    const { collection, embedding, k = 5, filters } = req.body || {};
    const hits = await vectors.search(collection, { embedding, k, filters });
    res.json(hits);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Graph query API
app.post("/graph/query", async (req, res) => {
  try {
    const { from, rel, to } = req.body || {};
    const edges = await graph.query({ from, rel, to });
    res.json(edges);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.get("/__specs/openapi.yaml", async (_req, res) => {
  try {
    const data = await readFile(
      resolve(repoRoot, "specs/api/openapi.yaml"),
      "utf8"
    );
    res.setHeader("content-type", "text/yaml; charset=utf-8");
    res.send(data);
  } catch {
    res.status(404).send("missing openapi.yaml");
  }
});
app.get("/__specs/asyncapi.yaml", async (_req, res) => {
  try {
    const data = await readFile(
      resolve(repoRoot, "specs/events/asyncapi.yaml"),
      "utf8"
    );
    res.setHeader("content-type", "text/yaml; charset=utf-8");
    res.send(data);
  } catch {
    res.status(404).send("missing asyncapi.yaml");
  }
});

// Health endpoint
app.get("/healthz", async (_req, res) => {
  const tools = await loadToolSpecs();
  const events = await eventlog.list({});
  res.json({
    ok: true,
    plans: plans.size,
    tools: tools.length,
    events: events.length,
    ts: Date.now(),
  });
});

// Policy endpoints
app.get("/policy", async (_req, res) => {
  res.json(getPolicy());
});
app.post("/policy", async (req, res) => {
  setPolicy(req.body || {});
  res.json({ ok: true });
});

// Save a client-provided plan
app.post("/plans", async (req, res) => {
  const plan = req.body as Plan;
  if (!plan?.id) return res.status(400).send("plan.id required");
  log.info("plan_save", { planId: plan.id, source: "client" });
  plans.set(plan.id, plan);
  await eventlog.put({
    id: newId("evt"),
    ts: toEpoch(Date.now()),
    type: "PLAN_CREATED",
    actor: "metis",
    payload: { planId: plan.id, source: "client" },
  });
  res.status(201).json({ ok: true, id: plan.id });
});

// Append to event log
app.put("/eventlog/:id", async (req, res) => {
  const id = req.params.id;
  log.debug("eventlog_put", { id });
  await eventlog.put({ ...req.body, id });
  res.status(201).json({ ok: true });
});

// AI planner (server-side OpenAI usage)
app.post("/ai/plan", async (req, res) => {
  const goal = String((req.body?.goal ?? "") || "");
  if (!goal) return res.status(400).send("goal required");
  const project = req.body?.project
    ? String(req.body.project)
    : req.query.project
    ? String(req.query.project)
    : undefined;
  const tools = await loadToolSpecs();
  const caps = tools.map((t) => t.capability);
  let plan: any;
  const provider = (process.env.PLANNER_PROVIDER || "openai").toLowerCase();
  log.info("ai_plan_start", { provider, goal, caps: caps.length });
  try {
    plan =
      provider === "ollama"
        ? await planWithOllama(goal, tools)
        : await planWithOpenAI(goal, tools);
  } catch (e: any) {
    log.error("ai_plan_error", { error: String(e?.message || e) });
    return res.status(502).send(String(e?.message || e));
  }
  if (plan?.unachievable)
    return res.status(400).json({
      error: "UNACHIEVABLE",
      reason: plan.reason ?? "not possible with available tools",
    });
  if (!Array.isArray(plan?.steps)) return res.status(400).send("invalid plan");
  for (const s of plan.steps) {
    if (s?.toolCall?.capability && !caps.includes(s.toolCall.capability))
      return res
        .status(400)
        .send(`unknown capability ${s.toolCall.capability}`);
  }
  if (!plan.id) plan.id = newId("plan");
  if (!plan.intentId) plan.intentId = newId("intent");
  if (project) plan.project = project;
  log.info("ai_plan_valid", { planId: plan.id, steps: plan.steps.length });
  plans.set(plan.id, plan);
  await eventlog.put({
    id: newId("evt"),
    ts: toEpoch(Date.now()),
    type: "PLAN_CREATED",
    actor: "metis",
    payload: { planId: plan.id, source: "ai" },
    project,
  });
  // Asynchronous execution so the client can track progress immediately
  const executionId = newId("exec");
  (async () => {
    const startedAt = new Date();
    await eventlog.put({
      id: newId("evt"),
      ts: toEpoch(Date.now()),
      type: "EXECUTION_STARTED",
      actor: "metis",
      payload: { planId: plan.id, executionId },
      project,
    });
    log.info("plan_execute_start", {
      planId: plan.id,
      steps: plan.steps.length,
      executionId,
    });
    try {
      const stepResults = await executePlanWithTools(plan);
      await eventlog.put({
        id: newId("evt"),
        ts: toEpoch(Date.now()),
        type: "EXECUTION_COMPLETED",
        actor: "metis",
        payload: {
          planId: plan.id,
          executionId,
          status: "completed",
          durationMs: Date.now() - startedAt.getTime(),
          stepResultsCount: stepResults.length,
        },
        project,
      });
      log.info("plan_execute_complete", {
        planId: plan.id,
        durationMs: Date.now() - startedAt.getTime(),
        executionId,
      });
    } catch (e: any) {
      await eventlog.put({
        id: newId("evt"),
        ts: toEpoch(Date.now()),
        type: "EXECUTION_COMPLETED",
        actor: "metis",
        payload: {
          planId: plan.id,
          executionId,
          status: "failed",
          error: String(e?.message || e),
        },
        project,
      });
      log.error("plan_execute_failed", {
        planId: plan.id,
        executionId,
        error: String(e?.message || e),
      });
    }
  })();
  res.status(202).json({ planId: plan.id, executionId, status: "started" });
});
