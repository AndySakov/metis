import Ajv from "ajv";
import addFormats from "ajv-formats";
import { loadToolSpecs, selectToolForCapability } from "./tools.js";
import { StepResult } from "../types.js";
import {
  artifacts,
  eventlog,
  graph,
  vectors,
  approvals,
  getPolicy,
  isStepApproved,
  isStepRejected,
} from "../stores.js";
import { createLogger } from "./logger.js";
const log = createLogger("execute");

const ajv = new Ajv.default({ allErrors: true, strict: false });
addFormats.default(ajv);

function compileValidator(schema: any) {
  try {
    if (!schema) return undefined;
    return ajv.compile(schema);
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

export async function runTool(toolSpec: any, input: any): Promise<any> {
  const cap = toolSpec.capability;
  log.info("run_tool", { capability: cap });
  if (cap.startsWith("research.search@")) {
    const q = String(input?.query ?? "").slice(0, 80);
    return {
      results: [
        {
          url: "https://example.com/a",
          title: `About ${q}`,
          snippet: `Snippet for ${q} A`,
          score: 0.9,
        },
        {
          url: "https://example.com/b",
          title: `More ${q}`,
          snippet: `Snippet for ${q} B`,
          score: 0.8,
        },
      ],
    };
  }
  if (cap.startsWith("research.fetch@")) {
    const url = String(input?.url ?? "https://example.com");
    return {
      text: `Fetched content from ${url}`,
      metadata: { title: `Title of ${url}` },
    };
  }
  if (cap.startsWith("research.summarize@")) {
    const chunks = Array.isArray(input?.chunks) ? input.chunks : [];
    const text = chunks
      .map((c: any) => c?.text)
      .filter(Boolean)
      .join("\n\n");
    return { markdown: `# Summary\n\n${text.slice(0, 300)}\n`, citations: [] };
  }
  if (cap.startsWith("design.prd@")) {
    const title = String(input?.title ?? "Untitled");
    return { markdown: `# PRD: ${title}\n\n## Overview\n\nTBD.\n` };
  }
  if (cap.startsWith("transform.extract@")) {
    const text = String(input?.text ?? "");
    const pattern = String(input?.pattern ?? "");
    const re = new RegExp(pattern, "g");
    const matches: { match: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      matches.push({ match: m[0], index: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return { matches };
  }
  if (cap.startsWith("graph.link@")) {
    const from = String(input?.from ?? "");
    const rel = String(input?.rel ?? "");
    const to = String(input?.to ?? "");
    const props = (input?.props ?? {}) as Record<string, unknown>;
    if (!from || !rel || !to) return { ok: false };
    await graph.upsertEdges([{ from, rel, to, props }]);
    return { ok: true };
  }
  if (cap.startsWith("vector.upsert@")) {
    const collection = String(input?.collection ?? "");
    const id = String(input?.id ?? "");
    const embedding = Array.isArray(input?.embedding)
      ? (input.embedding as number[])
      : [];
    const meta = (input?.meta ?? {}) as Record<string, unknown>;
    if (!collection || !id || embedding.length === 0) return { ok: false };
    await vectors.upsert(collection, { id, embedding, meta });
    return { ok: true };
  }
  return {};
}

function matchCap(pattern: string, cap: string): boolean {
  if (pattern === "*") return true;
  if (pattern === cap) return true;
  const [pName, pVer] = pattern.split("@");
  const [cName, cVer] = cap.split("@");
  if (pName !== cName) return false;
  if (!pVer || !cVer) return false;
  if (pVer.endsWith(".*")) {
    const major = pVer.slice(0, -2);
    return cVer.startsWith(`${major}.`);
  }
  return pVer === cVer;
}

export async function executePlanWithTools(plan: any): Promise<StepResult[]> {
  log.info("execute_plan_begin", { planId: plan?.id });
  const tools = await loadToolSpecs();
  const results: StepResult[] = [];
  for (const step of plan.steps ?? []) {
    log.debug("execute_step", {
      planId: plan.id,
      stepId: step.id,
      kind: step.kind,
    });
    // explicit requiresApproval flag
    if (step?.requiresApproval) {
      const created = approvals.require(plan.id, step.id);
      if (created) {
        await eventlog.put({
          id: `evt_${Date.now()}_${Math.random()}`,
          ts: Math.floor(Date.now() / 1000),
          type: "APPROVAL_REQUIRED",
          actor: "metis",
          payload: { planId: plan.id, stepId: step.id },
        });
      }
      const verdict = await approvals.wait(plan.id, step.id);
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "APPROVAL_DECIDED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id, verdict },
      });
      if (verdict !== "granted") {
        results.push({
          stepId: step.id,
          status: "skipped",
          output: { reason: "approval_denied" },
        });
        continue;
      }
    }
    // policy-based approval and allow/deny checks
    const policy = getPolicy();
    const capabilityForPolicy = String(step?.toolCall?.capability || "");

    // Enforce deniedCapabilities
    const isDenied = (policy.deniedCapabilities || []).some((p) =>
      matchCap(p, capabilityForPolicy)
    );
    if (isDenied) {
      results.push({
        stepId: step.id,
        status: "failed",
        output: { error: "DENIED_BY_POLICY", capability: capabilityForPolicy },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "STEP_REJECTED",
        actor: "metis",
        payload: {
          planId: plan.id,
          stepId: step.id,
          reason: "DENIED_BY_POLICY",
          capability: capabilityForPolicy,
        },
        project: plan.project,
      });
      continue;
    }

    // Enforce allowedCapabilities (if provided)
    const allowedCaps = policy.allowedCapabilities || ["*"];
    const isAllowed = allowedCaps.some((p) => matchCap(p, capabilityForPolicy));
    if (!isAllowed) {
      results.push({
        stepId: step.id,
        status: "failed",
        output: {
          error: "NOT_ALLOWED_BY_POLICY",
          capability: capabilityForPolicy,
        },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "STEP_REJECTED",
        actor: "metis",
        payload: {
          planId: plan.id,
          stepId: step.id,
          reason: "NOT_ALLOWED_BY_POLICY",
          capability: capabilityForPolicy,
        },
        project: plan.project,
      });
      continue;
    }
    if (isStepRejected(plan.id, step.id)) {
      results.push({
        stepId: step.id,
        status: "failed",
        output: { error: "REJECTED_BY_POLICY" },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "STEP_REJECTED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id },
      });
      continue;
    }
    const capForPolicy = capabilityForPolicy;
    const secondsBudget = Number(step.toolCall?.budget?.seconds ?? 0);
    const requiresApprovalByCap = (
      policy.requireApprovalCapabilities || []
    ).some((p) => matchCap(p, capForPolicy));
    const exceedsBudget = secondsBudget > (policy.maxBudgetSeconds || 0);
    const mustApprove =
      policy.requireApprovalAll || requiresApprovalByCap || exceedsBudget;
    if (mustApprove && !isStepApproved(plan.id, step.id)) {
      const created = approvals.require(plan.id, step.id);
      if (created) {
        await eventlog.put({
          id: `evt_${Date.now()}_${Math.random()}`,
          ts: Math.floor(Date.now() / 1000),
          type: "APPROVAL_REQUIRED",
          actor: "metis",
          payload: {
            planId: plan.id,
            stepId: step.id,
            capability: capForPolicy,
          },
        });
        // Emit alias per AsyncAPI naming
        await eventlog.put({
          id: `evt_${Date.now()}_${Math.random()}`,
          ts: Math.floor(Date.now() / 1000),
          type: "APPROVAL_REQUESTED",
          actor: "metis",
          payload: {
            planId: plan.id,
            stepId: step.id,
            capability: capForPolicy,
          },
          project: plan.project,
        });
      }
      const verdict = await approvals.wait(plan.id, step.id);
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "APPROVAL_DECIDED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id, verdict },
      });
      // Emit granted/denied aliases
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: verdict === "granted" ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id },
        project: plan.project,
      });
      if (verdict !== "granted") {
        results.push({
          stepId: step.id,
          status: "skipped",
          output: { reason: "approval_denied" },
        });
        continue;
      }
    }
    if (step.kind !== "tool" || !step.toolCall) {
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "STEP_SKIPPED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id, kind: step.kind },
      });
      results.push({ stepId: step.id, status: "skipped" });
      continue;
    }
    const selected = selectToolForCapability(tools, step.toolCall.capability);
    if (!selected) {
      results.push({
        stepId: step.id,
        status: "failed",
        output: { error: "NO_TOOL", capability: step.toolCall.capability },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "TOOL_FAILED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id, error: "NO_TOOL" },
        project: plan.project,
      });
      continue;
    }
    // Enforce allowedAuthScopes
    const toolScopes: string[] = Array.isArray(selected.authScopes)
      ? (selected.authScopes as string[])
      : [];
    const allowedScopes = policy.allowedAuthScopes || ["*"];
    const scopesAllowed =
      allowedScopes.includes("*") ||
      toolScopes.every((s) => allowedScopes.includes(s));
    if (!scopesAllowed) {
      results.push({
        stepId: step.id,
        status: "failed",
        output: { error: "SCOPES_NOT_ALLOWED", required: toolScopes },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "STEP_REJECTED",
        actor: "metis",
        payload: {
          planId: plan.id,
          stepId: step.id,
          reason: "SCOPES_NOT_ALLOWED",
          required: toolScopes,
        },
        project: plan.project,
      });
      continue;
    }
    const validateIn = compileValidator(selected.inputSchema);
    if (validateIn && !validateIn(step.toolCall.input)) {
      log.warn("tool_input_invalid", {
        stepId: step.id,
        capability: selected.capability,
      });
      results.push({
        stepId: step.id,
        status: "failed",
        output: { error: "INVALID_INPUT", details: validateIn.errors },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "TOOL_FAILED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id, error: "INVALID_INPUT" },
        project: plan.project,
      });
      continue;
    }
    await eventlog.put({
      id: `evt_${Date.now()}_${Math.random()}`,
      ts: Math.floor(Date.now() / 1000),
      type: "TOOL_STARTED",
      actor: "metis",
      payload: {
        planId: plan.id,
        stepId: step.id,
        capability: selected.capability,
      },
      project: plan.project,
    });
    let output: any;
    try {
      const ms = secondsBudget > 0 ? Math.floor(secondsBudget * 1000) : 0;
      const run = runTool(selected, step.toolCall.input);
      output = await withTimeout(run, ms, `tool ${selected.capability}`);
    } catch (e: any) {
      results.push({
        stepId: step.id,
        status: "failed",
        output: { error: String(e?.message || e) },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "TOOL_FAILED",
        actor: "metis",
        payload: {
          planId: plan.id,
          stepId: step.id,
          error: String(e?.message || e),
        },
        project: plan.project,
      });
      continue;
    }
    const validateOut = compileValidator(selected.outputSchema);
    if (validateOut && !validateOut(output)) {
      log.warn("tool_output_invalid", {
        stepId: step.id,
        capability: selected.capability,
      });
      results.push({
        stepId: step.id,
        status: "failed",
        output: { error: "INVALID_OUTPUT", details: validateOut.errors },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "TOOL_COMPLETED",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id, status: "failed" },
      });
      continue;
    }
    if (typeof (output as any)?.markdown === "string") {
      const md = (output as any).markdown as string;
      const artId = `art_${Date.now()}_${Math.random()}`;
      log.info("artifact_put", {
        artifactId: artId,
        bytes: Buffer.byteLength(md, "utf8"),
      });
      const bytes = Buffer.from(md, "utf8");
      await artifacts.put(artId, bytes, {
        kind: "markdown",
        title: (md.split("\n")[0] || "Artifact").replace(/^#\s*/, ""),
        uri: `mem://${artId}.md`,
        checksum: `sha256:${bytes.length}`,
        created_at: Math.floor(Date.now() / 1000),
        created_by: "metis",
        provenance: {
          planId: plan.id,
          stepId: step.id,
          capability: selected.capability,
          input: step.toolCall.input,
        },
      });
      await eventlog.put({
        id: `evt_${Date.now()}_${Math.random()}`,
        ts: Math.floor(Date.now() / 1000),
        type: "ARTIFACT_WRITTEN",
        actor: "metis",
        payload: { planId: plan.id, stepId: step.id, artifactId: artId },
        project: plan.project,
      });
      results.push({
        stepId: step.id,
        status: "completed",
        output: { artifactId: artId },
      });
    } else {
      results.push({ stepId: step.id, status: "completed", output });
    }
    await eventlog.put({
      id: `evt_${Date.now()}_${Math.random()}`,
      ts: Math.floor(Date.now() / 1000),
      type: "TOOL_COMPLETED",
      actor: "metis",
      payload: { planId: plan.id, stepId: step.id },
      project: plan.project,
    });
  }
  log.info("execute_plan_complete", {
    planId: plan?.id,
    steps: results.length,
  });
  return results;
}
