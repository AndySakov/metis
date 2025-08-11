#!/usr/bin/env node

const BASE = process.env.METIS_BASE_URL || "http://localhost:8080";

const req = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  // 1) Submit intent
  const intentId = `intent_demo_${Date.now()}`;
  const intent = {
    id: intentId,
    ts: new Date().toISOString(),
    actor: "user:demo",
    goal: "Draft a PRD for v1 test",
    autonomy: "S1",
  };
  const plan = await req("POST", "/intent", intent);
  console.log("Plan created:", plan.id, "steps:", plan.steps.length);

  // 2) Execute plan
  const exec = await req("POST", `/plans/${plan.id}/execute`, {});
  console.log("Execution status:", exec.status);
  const artifactOut = exec.stepResults.find(
    (s) => s.output && s.output.artifactId
  );
  if (artifactOut) {
    const meta = await req(
      "GET",
      `/artifacts/${artifactOut.output.artifactId}`
    );
    console.log("Artifact written:", meta.id, meta.title, meta.kind);
  } else {
    console.log("No artifact produced");
  }

  // 3) Quick event digest
  await sleep(100);
  const events = await req("GET", "/eventlog", undefined);
  const byType = events.reduce(
    (m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m),
    {}
  );
  console.log("Event counts:", byType);
};

main().catch((e) => {
  console.error("Demo failed:", e.message);
  process.exit(1);
});
