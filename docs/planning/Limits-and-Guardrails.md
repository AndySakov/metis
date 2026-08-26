# METIS Limits & Guardrails

## TL;DR

- Powerful but bounded by data quality, tool brittleness, model fallibility, and laws/ToS.
- Many risks can be reduced via design/ops discipline; some are structural (LLMs, open web, physics).

---

## 1) Security risks & vulnerabilities

### 1A) Largely avoidable (with design)

- Secrets exposure (API keys, cookies, device tokens)
  - Mitigate: least-privilege per tool, short TTLs, just-in-time secrets, vault, redaction-at-ingest, never echo secrets to logs, per-project credential scopes.
- Prompt injection / data exfiltration
  - Mitigate: content trust labels, untrusted “read-only” mode, strict tool-call allowlist, strip active content, critic to detect exfiltration prompts before tools run.
- Supply-chain risk in auto-built tools (Foundry)
  - Mitigate: signed modules, SBOMs, reproducible builds, mandatory review for S3/S4 tools, zero-trust sandboxes, dependency pinning + vuln scans.
- Model jailbreaks / policy overrides
  - Mitigate: system policy layer separate from LLM, rule-checking critics, approval gates on sensitive actions, hard capability boundaries.
- Cross-tenant data bleed (future multi-user)
  - Mitigate: per-tenant keys, connector scoping, private buckets excluded from learning by default, access audit trails.
- Over-automation on devices
  - Mitigate: S3 approvals, safety interlocks, dry-run previews, global kill switch.

### 1B) Hard-to-eliminate (manage)

- Hallucination (even with RAG)
  - Manage: claim/evidence graphs, citations with confidence, critics for uncertainty disclosure, “refuse without sources” policy.
- Adversarial content (prompt-injection-in-the-wild, obfuscated HTML)
  - Manage: sanitize + sandbox, multi-view parsing (DOM + AX + text), detectors, restricted privileges on external contexts.
- Web/mobile automation brittleness (layout drift, bot defenses)
  - Manage: accept non-determinism, bounded actions, human-in-the-loop, never bypass captchas/access controls; promote robust flows to tools.
- Data poisoning / skew
  - Manage: source trust tiers, reputation, quarantine corpora, drift reports; explicit opt-in for private buckets.
- Cost runaway
  - Manage: per-plan budgets, global caps, rate limiting, breakers, cost dashboards, fail-closed modes.
- Legal/ToS landmines
  - Manage: allow/deny lists, license tags, takedown pipeline, auto-block violations; dual-approval for money/PII.

---

## 2) Technological limitations

- LLM limits: context bounds, non-determinism, adversarial vulnerability, math/logic gaps without tools.
- Retrieval limits: hybrid recall is imperfect; freshness requires churn.
- Evaluation blind spots: hard to measure truth/utility in real time.
- Foundry realism: UI runners are flaky; OCR is slow; app updates break flows; AVDs are heavy.
- Latency vs depth: more retrieval/critics/tools increases latency.
- Heterogeneous connectors: APIs/auth/rates change; maintenance is ongoing.

---

## 3) Physical-world & operational constraints

- Device safety: printers/robots/automotive can harm.
- Environment/availability: offline/air-gapped modes reduce capability.
- Human factors: ambiguous intent, evolving prefs, approval fatigue.
- Regulatory: bio/chem, export controls, data residency, accessibility.

Policies: S3 approvals, interlocks, local-only modes, adaptive questioning, periodic settings reviews, domain guardrails/refusals.

---

## 4) Out-of-scope by design (even if feasible)

- Bypassing CAPTCHAs/anti-bot/paywalls; scraping against ToS.
- Fully autonomous payments/purchases without dual-approval and spend limits.
- Medical/legal/financial advice without citations/disclaimers/conservative refusal.
- Training on sensitive private content by default; cross-user blending.
- Impersonation (email/chat/voice) without per-use consent and caps.
- Social engineering to obtain access/information.

---

## 5) Unrealistic/impossible

- Perfect accuracy or zero hallucinations.
- Omniscient, complete web coverage.
- 100% reliable UI automation.
- Real-time general reasoning with full context for everything.
- Zero-cost, infinite scale.
- Provable safety in open-world autonomy.
- Breaking cryptography or undecidable/NP-hard problems instantly.
- Perfect privacy against a determined nation-state.

---

## 6) Often-missed edges

- Right-to-be-forgotten/takedowns: need purge API and provenance to delete derivatives.
- PII propagation in summaries/embeddings: enforce deletion cascades.
- License contamination (code/data): enforce license tags; guard copyleft.
- Model/tool drift: A/B + rollbacks.
- Shadow IT: Foundry agents must graduate with tests/owners/SLAs.
- Vendor cost policy changes: portability plan (containers/WASM, interfaces) + budget alerts.

---

## 7) Guardrails checklist

### Must-haves

- Policy-as-code (allow/deny, retention TTLs, license/IP).
- Gears S0–S4; dual-key for money/PII/device control.
- Signed modules + SBOM + repro builds; sandboxed execution. **Not met today** — see §9.
- Secrets hygiene (scoped, short-lived); redacted logs; secret scanning.
- Untrusted-content mode (sanitize, block writes, critics for injections).
- Tamper-evident event log; artifact checksums; global kill switch.

### Should-haves

- Drift monitors (retrieval, outputs, costs) + auto-rollback.
- Source reputation and quarantine corpus.
- Takedown/deletion cascade across vector/graph/artifact stores.
- Red-team tests (prompt injection, automation flake, data poisoning).
- Human-friendly approvals (diffs, screenshots, cost/time estimate).

### Nice-to-haves

- Differential privacy for adaptation on sensitive buckets.
- Per-domain safe plan library.
- Incident playbooks and who/what/how to revert.

---

## 9) Known gaps in the current implementation

Stated plainly rather than implied away. These are open, not managed.

- **Tool isolation is process-level only.** MCP servers are separate processes (ADR-017), so the
  boundary is the operating system's plus whatever METIS applies at dispatch. This is weaker than
  the container-or-WASM story in ADR-003. A WASM component host is the intended destination and has
  not been started. Until it exists, treat every tool as trusted-by-configuration and do not
  describe METIS as sandboxing tools.
- **No module signing, SBOM or reproducible builds.** Listed as must-haves above; none are built.
- **`research.fetch`'s SSRF guard is coarse.** It blocks by literal host — loopback, private ranges,
  and the link-local metadata address — but does not resolve DNS, so a hostname that resolves to a
  private address still reaches the network. Closing that means resolving and re-checking after
  every redirect, which belongs with the WASM sandbox work rather than being half-done in a tool.
- **Durability depends on which execution mode was used.** `restate` is durable; `direct` is not,
  and killing the process loses the run. The API reports the mode on every submission, so the
  distinction is visible — but any claim that "plans survive restarts" is only true of the durable
  path, and deployments that omit the Restate layer get the direct one.
- **The trust ledger is read-only.** It enforces the two-ledger promotion rule but nothing updates
  the scores, so no skill can currently be promoted or demoted by evidence.
- **Sampling bounds frequency, not severity.** Random verification of executed actions can tell you
  how often things go wrong. It will not reliably catch a single rare catastrophic action. Do not
  conflate the two in code or in any claim made about the system.

---

## 8) Acceptance criteria (guardrails)

1. Untrusted-mode injection blocked: rendering a hostile page yields a refusal, no tool writes; critic rationale logged; audit shows no secrets/tool calls.
2. Dual-key on payments: payment steps require two approvals; without both, action is not executed; screenshots + cost estimates captured.
3. Takedown cascade: deleting a source purges the external retrieval index, the `artifact_provenance` rows that derive from it, and ArtifactStore blobs; searches return no results; audit records purge. (ADR-013 dropped the dedicated graph store — provenance is relational, so the cascade is a delete across foreign keys plus one call to the retrieval service.)
4. Secrets hygiene: secret scanning blocks merging any artifact containing leaked tokens; logs redact secrets automatically.
5. Cost caps: exceeding plan or global caps aborts with user-visible explanation and audit of spend.
