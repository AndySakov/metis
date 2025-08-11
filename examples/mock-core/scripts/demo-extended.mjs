#!/usr/bin/env node
const BASE = process.env.METIS_BASE_URL || "http://localhost:8080";
const req = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.headers.get("content-type")?.includes("application/json")
    ? res.json()
    : res.text();
};

const main = async () => {
  // intent → plan
  const intent = {
    id: `intent_ext_${Date.now()}`,
    ts: new Date().toISOString(),
    actor: "user:demo",
    goal: "Draft a PRD for v1 test with sources",
    autonomy: "S1",
  };
  const plan = await req("POST", "/intent", intent);
  console.log(
    "Plan:",
    plan.id,
    plan.steps.map((s) => s.description)
  );

  // execute
  const exec = await req("POST", `/plans/${plan.id}/execute`, {});
  console.log("Exec:", exec.status);
  const artifactOut = exec.stepResults.find((s) => s.output?.artifactId)?.output
    ?.artifactId;
  if (artifactOut) {
    const meta = await req("GET", `/artifacts/${artifactOut}`);
    console.log("Artifact:", meta.id, meta.title);
  }

  // filter events: just TOOL_*
  const events = await req(
    "GET",
    "/eventlog?types=TOOL_STARTED&types=TOOL_COMPLETED"
  );
  console.log("Tool events:", events.length);
};

main().catch((e) => {
  console.error("Extended demo failed:", e.message);
  process.exit(1);
});
