# Capability Catalog (seed)

- research.search@0.1 — Retrieve ranked sources from the web or corpora
- research.fetch@0.1 — Fetch and clean content from a URL
- research.summarize@0.1 — Summarize chunks with citations
- design.prd@1.0 — Generate a PRD markdown from charter/constraints
- design.c4@1.0 — Generate C4 diagrams (Mermaid/PlantUML) from system descriptions
- design.api_spec@1.0 — Generate OpenAPI 3.1 specs from endpoint descriptions
- design.trade_study@1.0 — Produce weighted decision matrices with sensitivity analysis
- research.claim_graph@0.1 — Build claim–evidence graphs with provenance and confidence

Notes:

- Contracts define inputs/outputs and guarantees; multiple tools may satisfy a CAP.
- Planner targets CAP IDs; implementations are selected by policy.

---

## New capability families (proposed)

- agent.web_navigate@1.0 — Execute parameterized web navigation flows on allowed domains; outputs structured artifacts and evidence (screenshots, DOM extracts).
- agent.mobile_navigate@1.0 — Execute flows in a mobile simulator/emulator via accessibility selectors; outputs artifacts (screenshots, files).
- agent.os_automation@1.0 — Local desktop automations under sandbox with audit.
- agent.compose_api@1.0 — Compose multi-API workflows into a single capability when no monolithic tool exists.
