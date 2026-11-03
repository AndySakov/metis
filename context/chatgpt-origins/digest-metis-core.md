# METIS core: delta digest of the ChatGPT archive

Sources (`transcripts/`): **J** 2025-06-08 building-jarvis; **O** 2025-08-10 imagineering-copilot-design (origin); **T** 2025-08-10 jarvis-copilot-traits; **C** 2025-08-18 caia-and-metis-comparison; **N** 2025-10-18 naming-memory-fabric; **L** 2025-10-19 langchain-vs-vercel-sdk; **R** 2025-12-20 rdma-tech-in-mac-studio. Tags: **[in-repo]**, **[partial]**, **[not-in-repo]**, **[conflicts]**. Nothing Temi said contradicts a locked decision outright. Items 21 and 22 are in tension with ADR-013 and with current approval policy.

---

## 1. Owner intent (what Temi himself said)

### Purpose and ambition
1. **Near-AGI, modular, extensible.** "Basically as close to AGI as is possible… a modular system that can be extended with any functionality as needed", robotics deferred (J, 2025-06-08). **[partial]** Packs cover extensibility (CLAUDE.md); the near-AGI goal is written nowhere.
2. **A central node directing specialist modules.** He asked for a "Distributed system of specialized modules that all talk to each other and are controlled by a central node responsible for task processing and assignment" (J). **[in-repo]** This is the orchestrator plus MCP servers (ADR-017).
3. **Runs on any system** ("It will be able to operate in any system", J). **[not-in-repo]** Only the web console exists.
4. **Imagineering across arts, sciences, technologies and humanities**, "from the inchoate murmurings of my thoughts to exploration to design and if need be execution" (O, 2025-08-10). **[in-repo]** README tagline.
5. **"A fully capable extension of my human intellect"** that plays to the strengths of both (O). **[not-in-repo]**
6. **Voice or text; starts and manages projects on command** (O). **[partial]** Text intents work; no voice; a `project` table exists (`migrations/0001_initial.sql`) but no Project OS.
7. **Cross-project context**: "always have context about past and current (maybe planned future) projects so there can be cross dependency" (O). **[not-in-repo]**
8. **Polymath tutor**: "help me quickly get up to speed in whatever field I'm exploring… to as much depth as I require" (O). **[not-in-repo]** Not even in the historical roadmap.
9. **Public research plus private "data silos that aren't publicly accessible"** (O). **[partial]** `research.search` covers Wikipedia and arXiv only; private connectors are in the historical roadmap (Phase 9).
10. **Learns him**: "pick up turns of phrase and mannerisms and ways of working… ask a lot of questions… at first and require less and less handholding over time" (O). **[partial]** Autonomy ramp built (TrustLedger, gears); style and questioning learning are "designed, not built" (README).
11. **Name**: METIS, "named after the greek word Metis meaning device" (O). **[in-repo]**

### The seven codified requirements (O)
12. **Hot-swappable for years.** "Even several years down the line I should be able to build on the existing platform to upgrade it by hotswapping or upgrading components." **[in-repo]** CAP IDs, MCP and packs (ADR-003, ADR-006, ADR-017).
13. **Builds itself.** "Use Metis v1 to build Metis v2 (within reason) or… extend itself by building more module and components and applying the patches/upgrades." **[partial]** `build.scaffold` and `docs/templates/Agent-Tool-Graduation-PR.md` exist. There is no self-modification pipeline.
14. **Polymath range**, from "planning a trip around the world to building a tech product to planning mods for a car build". **[partial]** Packs are the mechanism. Field kits were never built.
15. **Many interfaces**: "a simpler mobile app for on-the-go work and a more sophisticated interface with AR/VR support at my main workstation." **[not-in-repo]** The headless HTTP API is the seam for these.
16. **Long-running background work.** Background tasks that can be "resumed to the foreground or interacted with mid process", "seamless transitioning between its various personas mid session", notifying him "when a result is available later on", and the ability to "park a project". **[partial]** Restate durable runs and real suspension on approvals are built (ADR-016). Persona switching, notifications and park/resume of whole projects are not.
17. **Secure by default and private "per my preferences".** **[in-repo]** Policy-as-code, red-team suite, gears (ADR-008, ADR-014).
18. **Device control**: "schedule a 3d printer print job… send it to my ipad… open up something on my computer." **[not-in-repo]** `agent.os_automation` is a descriptor only. ADR-015 expects a Rust device daemon.

### Process decisions
19. **No technology lock-in until the plan was finished** ("Let's not lock in any specific technologies… decide on that after the plan is complete", O). **[in-repo]** This was honoured: the stack was chosen later by ADR-011 to ADR-018.
20. **Named the memory layer.** He asked for a package name for the memory fabric (N, 2025-10-18). **[in-repo]** `mneme` (CLAUDE.md naming convention).

### Web memory, the Foundry, limits (O)
21. **Web memory as a core part of the memory fabric.** METIS should keep a searchable corpus "from a incrementally generated dataset (i.e I instruct it on certain swaths of links…)": Hacker News, "a telegram bot to join a bunch of web3 and security and general science research and news focused channels, arxiv and the other paper sources", "operating as a core part of the memory fabric". **[partial / tension]** `docs/capabilities/Web-Memory.md` captures the pipeline, but nothing is built. ADR-013 hands retrieval to an external vendor (supermemory), which sits poorly with item 24's data-sovereignty preference. See open question 3.
22. **On-the-fly agents (Adaptive Agent Foundry).** Agents built on the fly where no tooling exists: a web bot driving Skyscanner, a mobile AVD for apps with no web client. He wants both "major (user involved big deal 'hey metis, lets work on upgrading this major part of you')" and "minor (self triggered…)" upgrades, "until it becomes its own kind of larger than life organism where I don't have to build every little capability it has myself". **[partial]** `docs/capabilities/Adaptive-Agent-Foundry.md` and four `agent.*` descriptors exist; none is implemented. Self-triggered minor upgrades sit against the current rule that `build.scaffold` asks for approval at every gear. See open question 2.
23. **An honest list of limits.** He asked for both avoidable and unavoidable security risks, plus "stuff that is just plain impossible/unrealistic". **[in-repo]** `docs/planning/Limits-and-Guardrails.md`.

### Hardware (O, R)
24. **On-prem datacenter at home.** "A couple hundred TB of storage to start but I totally forsee petabyte scale in a couple years", with SSD and HDD tiers. Cloud is for cold backup or "temporary fast access" when fetching across regions. "Leaning toward on prem because data sovereignty, privacy and control". Targets: "gpt-5-pro scale with cutting edge multimodal support, real time inference and batch"; "ample amount of re embedding or retraining as it'll be an evolving brain"; high availability throughout; "single rack to start but… multiple rooms"; home first, then a workshop; "i don't have a budget… an on going evolution". **[not-in-repo]**
25. **Mac Studio cluster.** He asked for the "biggest setup i can achieve, assuming mac studios as the primary work horses and a top line mbp as the root node" (R, 2025-12-20). **[not-in-repo]**

### Private use (O)
26. **METIS stays private; its outputs make money.** "METIS itself will remain exclusively for my private use"; what it helps him build is where value comes from. **[in-repo]** Single user, not a product (CLAUDE.md, README).
27. **Claim, incentive and simulation engines.** He wants analysis built from three parts: **claim** ("is this bullshit, and how confident are you that it isn't"), **incentive** ("follow the money") and **simulation** ("battle test this thesis by aggresively poking billions of holes in it at crazy scale"). **[partial]** `research.claim_graph` is implemented. Incentive and simulation have no capability or contract.
### CAIA / ITRS thread (C, 2025-08-18; Temi's own email draft)
29. **Research interests and a reasoning-trace UI.** He describes a lifelong aim of "a JARVIS-esque AI that approaches AGI" as a "henchman/assistant in my regular tinkering". He was researching "intent parsing and DAG generation for AI planning workflows". He wanted to evaluate Thom Heinrich's ITRS/ChonkyDB as "the cortical stack of the agent's memory fabric". He valued a UI that shows "behind the scenes reasoning… which would make evaluation, tuning and auditing much easier". **[partial]** The console shows each policy decision, the rule behind it, and trust evidence. ITRS was never evaluated in the repo.

---

## 2. Ideas from the assistant worth keeping

**Learning and personalization (O, T): [not-in-repo]**, beyond the `preference/recorded` channel in `specs/events/asyncapi.yaml`.
- **PreferenceEvent** fields: domain, input fingerprint, alternatives plus the chosen index, `edit_ratio`, feedback tags, outcome, costs.
- **Nightly** StyleKit update (tone, lexicon, 10–20 exemplars) that proposes "two small changes every morning" as diffs. **Weekly** per-domain LoRA adapter, run in shadow before promotion, with a "what did you learn" changelog and one-click revert.
- **Contextual bandits** (Thompson or LinUCB) pick templates and tools. A **questioning policy** asks 1–3 questions only below a confidence threshold. A **domain-shift detector** raises questioning and demotes gears.
- **Cold start:** import 5–10 of his best artifacts plus a preference survey.
- **ADR-014 caveat:** these signals feed competence only, never compliance.

**Personality controls (T): [not-in-repo]**
- Temperament sliders (caution↔boldness, speed↔thoroughness, cost↔quality, exploration↔exploitation); modes (Scout, Architect, Builder, Critic, Guardian, Scribe, Concierge); memory tiers with TTLs and ask-to-store; quiet hours; named anti-traits (silent failure, consentless sticky memory, notification spam).

**Brain breakdown (O): [partial]**
- The reactive loop (perceive, plan, safety pass, execute, reflect) is mostly built.
- **Not built:** context-pack assembly (semantic top-k, plus project neighbours, plus a recent event-log window, ranked by recency × relevance × authority, with citations; graph hops become joins under ADR-013); a proactive loop where watchers emit micro-intents into the same pipeline and results land in digests; critics (safety, licence, privacy, feasibility, cost) that can block a plan; reflection micro-plans for auto-repair.

**Web memory specifics (O): [partial]** The repo doc has the pipeline but not these details.
- From Wilson Lin's search engine: sentence-level chunks with context stacking (headings, table headers, lead sentences); a "statement chaining" classifier linking a sentence to its antecedent; a pluggable LLM rerank stage; RocksDB queue and blobs with fixed shards for write-heavy ingest.
- **Cost tiers:**

  | Tier | Volume | Monthly cost | Notes |
  |---|---|---|---|
  | A | ~10k docs/day | $120–400 | One 16–32 vCPU box; ~14 GB raw text/month (gzipped) plus ~8.6 GB embeddings/month (10 chunks × 768 dims) |
  | B | ~100k docs/day | $600–1.2k | |
  | C | 100M+ pages | Low five figures | |

- Managed embeddings at ~$0.02 per 1M tokens (pennies at Tier A). Telethon for Telegram; Tantivy or Meilisearch for BM25. Routine crawling at S4; joining channels or large recrawls at S3.

**Foundry details missing from the repo doc (O): [not-in-repo]**
- A `CapabilityGap` event; `POST /foundry/compile`, `/foundry/run`, `/tools/propose` (returns PR URL and CAP ID); an action grammar (click, type, select, wait, extract); a per-step safety critic; DOM-snapshot and video forensics; failure-mode tracking that demotes brittle recipes.

**On-prem datacenter plan (O): [not-in-repo]**

| Stage | Hardware | Capital cost | Running cost |
|---|---|---|---|
| 1, home rack | One 4–8 GPU server (e.g. 4×A100 80GB), one ~200 TB ZFS storage server (~20×10–20 TB HDD plus NVMe cache), 10GbE switch, OPNsense/pfSense firewall, WireGuard VPN, 5–10 kVA UPS, acoustic rack, dedicated 240V 30–50A circuit | $80k–150k | ~5 kW continuous ≈ $540/month power |
| 2 | 2–3 racks, 5–10 servers, 100GbE with RoCE or InfiniBand, Ceph or Lustre | $300k–500k | 15–20 kW ≈ $1.5k+/month |
| 3 | ~10 GPU servers (~80 GPUs), 2–3 PB, liquid cooling | $2–3M | 50+ kW |

- Storage tiers: NVMe scratch, HDD capacity, object-store archive. An air-gap switch with a dual-homed staging box for updates.
- **Verdict:** on-prem wins when hardware is busy more than ~6 hours a day ($1M on-prem ≈ $4M cloud over 5 years); cloud for bursts only. "GPT-5-pro scale" training is not realistic at Stage 1; treat it as inference plus fine-tuning.

**Mac Studio RDMA cluster (R): [not-in-repo]**
- macOS 26.2 adds RDMA over Thunderbolt 5, used by MLX distributed (JACCL) and Exo.
- **Demonstrated:** 4× M3 Ultra (512 GB each, 2 TB total) in a 6-cable full mesh, with the MBP **outside** the fabric as control plane (UI, orchestration, secrets, policy).
- **Theoretical 7 nodes:** 21 cables, 224 CPU cores, 560 GPU cores, 3.58 TB memory, ~197 TFLOPS FP32, ~7.2T-parameter 4-bit ceiling. About 16.5 tok/s per node at 70B Q4; replicas scale throughput linearly, tensor-parallel single streams do not.
- **Fit:** the `ollama` and custom-command presets in `metis.model-cli` are the existing seam.

**CAIA conclusions (C): [not-in-repo]**
- **Correction:** ChatGPT wrongly treated CAIA as METIS's own layer. CAIA is Thom Heinrich's system.
- **Keep:** a sparse hand-built causal spine per domain (Beta–Bernoulli edges, Noisy-OR, offline structure learning with human approval); an Expected-Free-Energy action router with a CVaR(α=0.1) tail cap; a per-decision card (beliefs, EFE breakdown, action, outcome); lesion-style evals. Use only for uncertain, costly decisions. Under ADR-015 this is a pack, never core.

**Framework advice (L, J): [not-in-repo]** Still useful: a LiteLLM proxy (self-hosted, OpenAI-compatible) as another `metis.model-cli` custom command; OpenTelemetry for the Observability layer (README: "not started"); A2A "Agent Cards" if agent-to-agent interop is ever needed.

---

## 3. Superseded choices

| Chat choice | Where | Replaced by |
|---|---|---|
| Neo4j graph store (and the "fits your Neo4j expertise" framing) | O, C | ADR-013 (graph store dropped; provenance is relational), ADR-018; ADR-012 explicitly rejected Neo4j plus Postgres |
| Postgres + Neo4j + vector DB + object store (three/four tiers) | O | ADR-013 (two tiers plus external retrieval), ADR-007 |
| Gel/EdgeDB (not in these chats) | — | ADR-012, superseded by ADR-018 |
| NestJS orchestrator, Kafka/NATS event bus | O | ADR-011 (Effect); Postgres event log (ADR-007, ADR-016) |
| LangGraph for durable agents, LangSmith | L, J | ADR-016 (Restate), ADR-011 |
| Hand-built DAG scheduler | O roadmap | ADR-016 |
| Temporal / Redis workflow keyspace | C | ADR-016 |
| OCI/WASM plugin ABI, K8s job runner, vault | O | ADR-017 (MCP); WASM is a tier in ADR-020 |
| gRPC + GraphQL façade | O | HTTP `HttpApi` reconciled against OpenAPI (ADR-004, ADR-011) |
| Monorepo `/apps /packages /infra` (no Nx in these chats) | O | Never built; flat layout (README, REBUILD-PLAN) |
| Rust Local Agent with OctoPrint/AirPrint/iPad adapters | O roadmap | ADR-015 (Rust only after a measurement and an ADR) |
| Python–Rust CAIA bridge | C | ADR-015 |
| ULID ids, npm, Next.js canvas | O | UUIDv7 enforced; pnpm; web console at `/` |

**Artifact comparison.** The archived `imagineering-copilot-v1-roadmap.md` is the *earlier, stack-specific* draft (Neo4j/PG, NestJS, Next.js, OCI, Rust agent with OctoPrint/AirPrint/iPad adapters, gRPC+GraphQL, K8s+vault) and lacks phases 4a–9a. The repo copy is the later stack-neutral revision plus a historical banner; nothing of substance was lost. The archived phase-0 files hold PG migrations and a Neo4j bootstrap, both superseded by `migrations/0001_initial.sql`, and an OpenAPI that is a strict subset of `specs/api/openapi.yaml`. `artifacts/mae-spec-draft-v1.md` (Modular Agent Ecosystem) was outside this pass.

---

## 4. Open questions for Temi

1. **Local versus hosted models.** He named GPT-5/o3 and "gpt-5-pro scale" local inference. The repo runs Claude through the API or a CLI. Is local-first inference still a goal, and on what hardware: the GPU rack (O) or the Mac Studio cluster (R)?
2. **Gear for self-triggered upgrades.** He wants METIS to extend itself "self triggered". Today every `build.scaffold` run asks for approval, and graduation goes through a PR. May a graduated tool ever go live without his approval, and at which gear?
3. **Where web memory lives.** He called it "a core part of the memory fabric" and wants data sovereignty. ADR-013 puts retrieval with an external vendor. Should a self-hosted index (one adapter behind the existing tag) be the default?
4. **Telegram.** Joining channels needs a user account, not a bot. What scope is acceptable, and does each join need approval?
5. **Personas and tutoring.** Is mid-session persona switching still wanted (REBUILD-PLAN is silent)? Should the tutor/curriculum mode (item 8) be a pack?
6. **Incentive and simulation.** These two thirds of his analysis triad have no capability contracts. He has a separate project for a copilot that simulates conditions and battle-tests ideas, which overlaps with them. Should they be one effort or two?
7. **Agent marketplace recall.** ChatGPT's "recall metis" (R) attributes to him an agent marketplace with ENS-style naming, zk attestations and on-chain fees. None of that is in these transcripts; it probably comes from the MAE spec. It clashes with "exclusively for my private use" and CLAUDE.md's single-user rule. Is MAE a separate project?
8. **CAIA/ITRS.** Did the contact with Thom Heinrich go anywhere, and is a causal / active-inference decision layer still wanted, as a pack?
9. **Interfaces.** Which comes first after the console: mobile, voice, or AR/VR? And which devices first: the 3D printer, iPad hand-off, or desktop "open this"?
10. **Scale of ambition.** He has described the aim as Vision-level (Marvel) superintelligence. No repo doc states the long-range goal. Should one line in the README do so?
