# METIS — v1 Roadmap

> **Status: historical.** This is the original ten-phase plan, retained for the capability detail
> in it. It is **not** the current plan — `docs/planning/REBUILD-PLAN.md` is, and where the two
> disagree the rebuild plan and the ADRs win. Specifically superseded here: the monorepo layout
> (never built, see §2), the hand-built DAG scheduler (ADR-016 adopts Restate), container/WASM tool
> packaging (ADR-017 adopts MCP), the TBD datastore (ADR-018 selects PostgreSQL), and the
> three-tier memory model (ADR-013 reduces it to two plus external retrieval).

**Goal**: A Jarvis-grade copilot that takes ideas from spark → exploration → design → execution, learns your style, and reduces handholding over time.

## Name & identity

- **Name:** METIS — Modular Engine for Thought, Insight, and Synthesis.
- **Etymology:** from Greek “mētis,” often glossed as device/plan, craft, and cunning counsel.
- **Wake phrase:** “Hey Metis …” (text alias: `@metis`).
- **Acronym use:** Use METIS in caps; expand on first mention in docs.

---

## 0) Scope & Tenets

- **Always visible plan**: No hidden steps—planner outputs a readable plan + diffs.
- **Memory with provenance**: Graph + vectors + timeline; every write has a source.
- **Safety via gears**: S0 advise → S1 draft → S2 sandbox run → S3 gated run → S4 scheduled autonomy.
- **Learning-first**: nightly/weekly adaptation, shadow-eval, revertable.
- **Local-first privacy**: redaction, encrypted stores, connector-scoped permissions.
- **Composability for years**: stable capability contracts, semantic versioning, plugin ABI, hot-swap loader, and state migrations.
- **Self-bootstrapping**: METIS can scaffold/extend its own modules under approval gates, via "build-yourself" personas and PR workflows.
- **Polymath breadth**: domain-agnostic planning + domain "field-kits" (travel, product, car builds, research, etc.).
- **Interface plurality**: headless core API; thin clients for mobile/desktop; AR/VR adapters; unified presence & session handoff.
- **Long-running orchestration**: background DAGs with checkpointing, pause/resume, and mid-session persona swaps.
- **Device & environment control**: secure local agent to talk to printers, tablets, desktops, etc.

---

## 1) Architecture Overview (v1)

### Layers

1. **Interface**: Realtime voice + chat + multimodal canvas + command palette.
2. **Orchestrator**: intent parser → planner → tool dispatcher → memory writes.
3. **Memory Fabric**: Graph store (TBD), Event/relational store (TBD), Vector index (TBD), Artifact/object store (TBD), timeline/event log.
4. **Knowledge Engine**: retrieval pipelines (public + private connectors), web-memory feeds (incremental ingest + hybrid search), claim/evidence extraction.
5. **Tooling/Execution**: containerized tools, notebook runner, CI hooks.
6. **Adaptive Agent Foundry**: gap detection → on-the-fly agent synthesis (web/mobile/OS/API) → guarded execution → graduation to reusable Tool.
7. **Governance/Safety**: capability gating, approvals, audit, license/IP checks.
8. **Observability**: traces, cost/latency budgets, dashboards.

### 1A) Foundational capabilities (codified)

#### Composability & upgradeability

- **Capability Contracts (CAP IDs):** each tool exposes a stable capability (e.g., `design.c4@1`), with JSON Schemas for inputs/outputs. Back-compat for `N-2` minor versions.
- **Semantic Versioning Policy:** `MAJOR.MINOR.PATCH`; breaking changes require migration scripts + deprecation schedule.
- **Plugin ABI & Hot-Swap Loader:** tools packaged using a portable module format (e.g., containers or WASM components); loaded/unloaded at runtime; health checks + circuit breakers.
- **State Migration Framework:** declarative data migrations for the selected datastores; dry-run + rollback.
- **Feature Flags/Experiments:** progressive delivery for new modules; shadow/percent rollouts.

#### Self-bootstrapping

- **Builder Personas:** `@metis-build` (scaffold), `@metis-refactor` (upgrade), `@metis-test` (eval).
- **Pipeline:** spec → codegen → unit tests → sandbox run → PR → approval → rollout; all actions logged in ADRs.
- **Guardrails:** mutation budgets, signed modules, reproducible builds, supply-chain attestation (SLSA-style optional).

#### Polymath domain support

- **Field Kits:** curated plan templates, tools, metrics, and acceptance criteria per domain (e.g., Travel, Product, Research, Car Mods).
- **Domain Switch Heuristics:** switch questioning depth and tool choices based on domain familiarity and risk.

#### Interface layer

- **Headless Core API:** RPC/protocol TBD (e.g., gRPC or GraphQL); clients for web, mobile, CLI, AR/VR.
- **Presence & Handoff:** resume sessions across devices; background tasks notify the active client.
- **UI SDK:** components for plan view, artifact diff, claim graph, approvals.

#### Task orchestration & personas

- **DAG Scheduler:** durable background DAGs with retries, backoff, checkpoints; pause/resume/park.
- **Persona Router:** swap Explorer/Designer/Builder/Critic/PM mid-plan; per-step persona override.
- **Notifications:** local push + email/Matrix; digest for "what completed while away".

#### Security & privacy

- **Zero-Trust:** per-tool sandbox (seccomp/wasm), least-privilege tokens, scoped connectors.
- **Key Management:** hardware-backed keys (FIDO2) optional; vault for secrets; client-side encryption for personal memory.
- **Policy-as-Code:** deny/allow lists, data retention TTLs, redaction rules, license/IP guard.
- **Audit & Forensics:** signed logs, plan diffs, artifact checksums, tamper-evident timeline.

#### Device & environment orchestration

- **METIS Local Agent (implementation TBD):** runs on LAN; discovers devices (mDNS), speaks common protocols (e.g., MQTT, IPP, SSH, WebDAV).
- **Adapters:** categories include 3D printers, printers, tablet sync, and desktop control (protocols/adapters TBD; examples may include OctoPrint, IPP, Shortcuts, native OS automation).
- **Secure Pairing:** QR-based pairing, per-device capabilities, revocation.

---

## 2) Repo & Project Structure (monorepo — NOT BUILT)

The layout below was never created. The actual layout is flat and is documented in `README.md`.
It is kept here as the shape to grow into if and when a split is justified, not as a description
of the repository.

```text
/metis
  /apps
    /api-orchestrator (tech TBD)
    /realtime-gateway (protocol TBD)
    /canvas-app (tech TBD)
  /packages
    /planner-core (library)
    /tool-registry (schemas + adapters)
    /memory-client (SDK)
    /connectors (docs, drive, arXiv, github, jira, etc.)
    /evaluation (harness + metrics)
  /infra
    /k8s (jobs, services, secrets)
    /db (migrations: stores TBD)
  /docs
    /adrs
    /charters
    /capabilities
      - Web-Memory.md
      - Adaptive-Agent-Foundry.md
    /templates
      - Agent-Tool-Graduation-PR.md
```

---

## 3) Data & Schemas (v1)

### 3.1 Core Contracts

```ts
// Intent produced by NLU
export type Intent = {
  id: string; ts: number; actor: "user"|"system";
  goal: string;        // "Draft PRD for X"
  inputs?: Record<string, any>; // refs to artifacts/context
  constraints?: string[];
  autonomy?: 0|1|2|3|4; // requested gear
};

// Planner output (executable plan)
export type Plan = {
  id: string; intentId: string;
  steps: PlanStep[];
  assumptions: string[];
  risks: string[];
  expectedArtifacts: string[];
};

export type PlanStep = {
  id: string; kind: "tool"|"ask"|"write"|"decision";
  description: string;
  toolCall?: ToolCall;
  requiresApproval?: boolean;
};

export type ToolCall = {
  tool: string; version: string;
  input: Record<string, any>;
  budget?: { seconds?: number; dollars?: number; tokens?: number };
};

// Tool spec (registry)
export type ToolSpec = {
  name: string; version: string; capability: string; // e.g. "research.search"
  inputSchema: any; outputSchema: any;
  authScopes: string[]; sandboxed: boolean;
  costs?: { fixed?: number; perUnit?: number };
  tests?: { name: string; input: any; expect: any }[];
};
```

### 3.2 Project OS

```ts
export type ProjectCharter = {
  id: string; title: string; purpose: string; scope: string[];
  constraints: string[]; success: string[]; risks: string[];
  stakeholders: string[]; schedule?: string; budget?: string;
  artifacts: string[];
};

export type ADR = {
  id: string; projectId: string; title: string;
  context: string; decision: string; status: "proposed"|"accepted"|"superseded";
  alternatives: { option: string; pros: string[]; cons: string[] }[];
  consequences: string[]; links: string[];
};

export type WorkItem = {
  id: string; projectId: string; title: string; status: "todo"|"doing"|"done";
  dependsOn?: string[]; produces?: string[]; owner?: string;
};
```

### 3.3 Learning & Events

```ts
export type PreferenceEvent = {
  ts: number; project: string; domain: string;
  input_fingerprint: string;
  proposed: Plan[]; chosen: number;
  edit_ratio?: number; feedback?: Record<string, boolean|string>;
  outcome?: "accepted"|"rejected"|"revised"|"scheduled";
  costs?: { time_s: number; tokens?: number; usd?: number };
};

export type PersonaPack = {
  version: string; created_at: number;
  styleKit: StyleKit; toolPolicy: any; questioning: any; trust: Record<string, number>;
};

export type StyleKit = {
  tone: { concise: boolean; hedging: "low"|"med"|"high"; structure: string };
  lexicon: string[];
  exemplars: { name: string; text: string }[];
};
```

### 3.4 Storage

- **Event/relational store:** timeline/events, work items, plans, charters, ADRs, artifacts (metadata).
- **Graph store:** project–artifact–decision–claim–source relations and provenance.
- **Vector index:** collections `personal.exemplars`, `project.context`, `docs.corpus`.
- **Artifact/object store:** versioned blobs with checksums and lifecycle policies.

---

## 4) Phase Plan & Exit Criteria

### Phase 0 — Groundwork & Guardrails

#### Objectives — Phase 0

- Monorepo scaffold, CI, secrets, lint/test, typed schemas, migrations.
- Tool Registry with validation + unit tests.
- Safety gears implementation skeleton.

#### Deliverables — Phase 0

- Repo scaffold; CI (lint, tests); basic k8s manifests.
- `tool-registry` package with loader + JSON schema validation.
- ADR-000: Architecture; ADR-001: Memory model; ADR-002: Autonomy gears.

#### Exit Criteria — Phase 0

- Run `pnpm test` → all green. Load example tools; reject invalid specs. Create/read ADRs via API.

---

### Phase 1 — Core Loop (Plan → Execute → Memory)

#### Objectives — Phase 1

- Parse an intent, produce a plan, execute 2–3 tool steps, write artifacts + provenance.

#### Deliverables — Phase 1

- `planner-core` with plan templates & constraints.
- `api-orchestrator` routes: `/intent`, `/plan/:id/execute`, `/artifacts/:id`.
- `memory-client` write API (Neo4j/PG/Vector).

#### Exit Criteria — Phase 1

- Demo: “Draft PRD for X” → plan with 3 steps → execute → PRD artifact stored + ADR stub.

---

### Phase 2 — Project OS v1

#### Objectives — Phase 2

- CRUD for ProjectCharter, WorkItems, ADRs; dependency graph; reviews.

#### Deliverables — Phase 2

- Endpoints: `/projects`, `/adrs`, `/work` with filters & links.
- Canvas views: Charter, Work Graph (C4-ish), ADR diff.

#### Exit Criteria — Phase 2

- Create a project from chat; see tasks graph; add ADR; mark done; auto-update timeline.

---

### Phase 3 — Memory Fabric v1 & Persona Pack v1

#### Objectives — Phase 3

- Vector + graph + timeline cohesion; context packs; preference event logging.

#### Deliverables — Phase 3

- `events_preference` ingestion; nightly aggregator job (ETL).
- Persona Pack generation (StyleKit + questioning rules + trust ledger).

#### Exit Criteria — Phase 3

- After 10 tasks, system proposes 2 style tweaks; can revert/promote.

---

### Phase 4 — Research Engine v1

#### Objectives — Phase 4

- Retrieval with citations; claim/evidence panels; source licensing flags.

#### Deliverables — Phase 4

- Tools: `research.search`, `research.fetch`, `research.summarize`, `research.claim_graph`.
- UI: Source list, claim graph mini-panel, citation export.

#### Exit Criteria — Phase 4

- Query topic → 5–10 sources with confidence & license; generate a related-work brief with claims.

---

### Phase 4a — Self-Bootstrap Toolchain

**Objectives**: Use METIS to build METIS modules. **Deliverables**: `@metis-build` personas; codegen/test/sandbox/PR pipeline; signed module format; rollout playbook.  

**Exit Criteria**: From a spec, METIS opens a PR adding a new tool; tests green; approval prompts; module hot-swapped.

---

### Phase 4b — Web Memory v1

**Objectives**: Continuous, policy-aware ingestion from targeted public feeds (HN, arXiv/OpenAlex, Telegram channels, RSS/blogs), normalization + chunking with context, hybrid retrieval (BM25 ∪ vector), provenance writes.

**Deliverables**:

- Connectors (seed): HN API/RSS, arXiv/OpenAlex, Telegram (scoped), generic RSS/Atom.
- Ingest pipeline: fetch → normalize (readability + site rules) → chunk (sentence/para + headings) → embed → dedup → index.
- Services/APIs: `/web-memory/search`, `/web-memory/answer`, `/web-memory/feed`.
- Governance: robots/noindex honor, license tags, takedown path.

**Exit Criteria**: Index ≥10 sources/feeds with daily refresh; search returns citations with provenance; weekly digest of “what’s new” is generated; storage costs and per-source rate limits enforced.

---

### Phase 5 — Design Studio v1

#### Objectives — Phase 5

- Generators for PRD, C4 diagrams, API specs, schema drafts; trade study matrix.

#### Deliverables — Phase 5

- Tools: `design.prd`, `design.c4`, `design.api_spec`, `design.trade_study`.
- Templates + exporters (Markdown/PlantUML/Mermaid/OpenAPI).

#### Exit Criteria — Phase 5

- Given a charter, produce PRD + C4 + API skeleton + trade study with ranked options.

---

### Phase 6 — Execution Layer v1

#### Objectives — Phase 6

- Codegen with tests, notebook runner, CI scaffold; secure secrets.

#### Deliverables — Phase 6

- Tools: `build.codegen`, `build.scaffold`, `run.notebook`, `ci.setup`.
- Job runner (orchestrator TBD), secrets manager (TBD), artifact checksums.

#### Exit Criteria — Phase 6

- Create service scaffold (NestJS) with tests; run notebook; CI passes; provenance recorded.

---

### Phase 6a — Background Orchestration & Personas

**Objectives**: Durable DAGs, pause/resume/park, persona swapping mid-run.  

**Deliverables**: DAG scheduler service; checkpoint store; persona router; notification gateway.  

**Exit Criteria**: Start a long run, pause, switch persona, resume; audit shows checkpoints and diffs.

---

### Phase 6b — Adaptive Agent Foundry

**Objectives**: Synthesize task-specific agents when a capability gap is detected; run with safety gates; graduate successful runs into Tools with CAP IDs.

**Deliverables**:

- AgentSpec DSL (goal, inputs, environment, success, safety/budgets).
- Runners: web (DOM+AX+visual), mobile (AVD/Sim+driver), OS automation; API composer.
- Recorder/Parametrizer; PR generator to propose new Tool with schemas and tests.
- Approvals UI for S3 actions with screenshots, diffs, and cost/time estimates.

**Exit Criteria**: From a natural request lacking an existing tool, system builds a micro-agent, completes the task up to approval gates, and opens a PR proposing a new tool (e.g., `travel.flight_book@1.0`) with tests; tool can hot-swap in on approval.

---

### Phase 7 — Autonomy & Safety v1

#### Objectives — Phase 7

- Gears, approvals, dual-key for sensitive actions, license/IP checker.

#### Deliverables — Phase 7

- Approval UI with diffs; policy store; license & IP scan tool.

#### Exit Criteria — Phase 7

- Attempt S3 action → requires approval with diff & cost estimate; audit trail stored.

---

### Phase 7a — Security Hardening

**Objectives**: Sandboxes, policy-as-code, encryption at rest/in use, audit trails.  

**Deliverables**: Vault integration; per-tool sandboxes; data retention policies; license/IP checker v1.1.  

**Exit Criteria**: Pen-test checklist passes; red-team scenarios logged and blocked.

---

### Phase 8 — UX & Realtime Voice v1

#### Objectives — Phase 8

- Voice I/O (STT/TTS), barge-in, summaries on demand; command palette; session digest.

#### Deliverables — Phase 8

- Realtime gateway (protocol TBD, e.g., WS/WebRTC), hot-swappable STT/TTS adapters.
- Canvas: command palette (⌘K), multimodal pane, “what changed” digest.

#### Exit Criteria — Phase 8

- Talk → interrupt → system adapts mid-plan; palette runs tools by name with arg inference.

---

### Phase 8a — Interface SDK & Multi-Client

**Objectives**: Headless API + Mobile quick-capture + desktop canvas + AR/VR adapter stubs.  

**Deliverables**: API façade (protocol TBD); client SDKs; presence/handoff; mobile prototype.  

**Exit Criteria**: Capture on phone → plan/refine on desktop → AR viewer shows diagrams.

---

### Phase 9 — Connectors v1

#### Objectives — Phase 9

- Public corpora (arXiv/OpenAlex), personal docs (Drive, Notion), code (GitHub), tasks (Jira), storage (S3).

#### Deliverables — Phase 9

- Connector SDK; per-connector scopes; local indexing + redaction.

#### Exit Criteria — Phase 9

- Connect two private sources; retrieve & cite; respect scope & redaction.

---

### Phase 9a — Device & Environment Orchestration

**Objectives**: Local Agent + device adapters + secure pairing.  

**Deliverables**: Rust daemon; OctoPrint/IPP/SSH adapters; pairing UI; device registry.  

**Exit Criteria**: "Print part X on Voron at 0.2mm" runs via OctoPrint; "Send doc to iPad" syncs; "Open design on desktop" executes securely.

---

### Phase 10 — Evaluation & Launch

#### Objectives — Phase 10

- Metrics, dashboards, eval harness, red-team tests, rollback procedures.

#### Deliverables — Phase 10

- Dashboards: time-to-accept, edit-ratio, first-try success, question count, safety hits.
- Shadow eval & promotion rules; incident playbook.

#### Exit Criteria — Phase 10

- 2-week shadow eval shows ≥20% improvement in time-to-accept, no safety regressions; promotion executed.

---

### Appendix — Limits & Guardrails

See `docs/planning/Limits-and-Guardrails.md` for a full treatment of:

- Security risks (avoidable vs. managed), technological limits, physical/operational constraints
- Out-of-scope by design vs. unrealistic/impossible items
- Often-missed edges (takedowns, PII in embeddings, license contamination, drift)
- Guardrails checklist and acceptance criteria (prompt injection blocked in untrusted mode; dual-key for payments; takedown cascades; secrets hygiene; cost caps)

## 5) Detailed Backlog (initial)

### A. Tooling (must-have)

1. **research.search**: query, filters → ranked sources (url, title, snippet, license, date, score).
2. **research.fetch**: url → clean text, metadata, license.
3. **research.summarize**: chunks → TL;DR + citations.
4. **design.prd**: inputs (charter, constraints) → PRD markdown.
5. **design.c4**: system description → PlantUML/Mermaid diagrams.
6. **design.api\_spec**: endpoints → OpenAPI 3.1.
7. **design.trade\_study**: criteria + options → weighted ranking + sensitivity analysis.
8. **build.scaffold**: service name + stack → repo skeleton + tests.
9. **build.codegen**: spec → code + tests (guardrails + coverage target).
10. **run.notebook**: notebook code → executed notebook artifact.
11. **research.claim_graph**: sources → claims–evidence graph with provenance and confidence.

### B. Learning & Persona

- Nightly aggregator (ETL SQL), style kit builder, adapter training job (LoRA), bandit policy service.

### C. Safety & Governance

- License/IP checker, autonomy policy store, approval mesh, audit trail.

---

## 6) Acceptance Tests (golden demos)

1. **Idea→PRD→Scaffold**: “Build a research summarizer service.” Output: PRD + C4 + API + service scaffolding + CI passing.
2. **Literature Map**: “State of the art on retrieval-augmented generation.” Output: 10 sources, claim graph, related-work section with citations.
3. **Learning Adaptation**: After 10 tasks, system auto-shortens intros and prefers numbered steps; you can revert in one click.
4. **Voice Loop**: Mid-plan change via voice; approval prompt blocks S3 action; audit logged.

---

## 7) Risks & Mitigations

- **Hallucination** → strict citations, claim graphs, critic pass, refusal when uncertain.
- **Privacy/Leakage** → local indexing, connector scopes, redaction, encryption, no training on sensitive buckets by default.
- **Tool drift/cost** → budget caps, cost-aware planner, observability alerts.
- **Overfitting to style** → weekly cross-domain sanity checks; cap adapter updates.

---

## 8) Immediate Next Step (Phase 0 deliverables)

- Create ADR-000 (Architecture) + ADR-001 (Memory model) + ADR-002 (Autonomy gears).
- Implement Tool Registry schemas + validation tests.
- Stand up in-memory dev stores implementing the stack-neutral interfaces.

### Artifacts to produce next

- ADR templates
- JSON Schemas for ToolSpec, Intent, Plan
- In-memory dev stores implementing EventLogStore, GraphStore, VectorIndex, ArtifactStore
- Storage interface contracts + minimal in-memory adapters

---

## 9) Templates

### ADR Template

```markdown
# ADR-XYZ: <Title>
## Status
Proposed | Accepted | Superseded by ADR-XYZ
## Context
<Problem and forces>
## Decision
<What we decided and why>
## Alternatives
- Option A (pros/cons)
- Option B (pros/cons)
## Consequences
<Positive/negative outcomes>
## Links
<Related ADRs, issues, PRs>
```

### Project Charter Template (YAML)

```yaml
id: proj-<slug>
title: <Title>
purpose: <Why>
scope:
  - <In-scope>
constraints:
  - <Constraint>
success:
  - <Measurable outcome>
risks:
  - <Risk>
stakeholders:
  - <You>
schedule: <milestones>
budget: <optional>
artifacts: []
```

---

## 10) Definition of “v1 Complete”

- Core loop stable; Project OS usable daily; Research & Design flows produce publishable artifacts with citations; Execution scaffolds working code; Safety gears enforced; Voice UX reliable; Learning reduces handholding measurably (≥20% drop in edit ratio on familiar domains) with auditable rollbacks.
