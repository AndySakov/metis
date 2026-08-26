# Adaptive Agent Foundry

## Purpose

When a capability gap is detected, synthesize a task-specific agent (web/mobile/OS/API), run under budgets and approvals, then graduate the successful flow into a reusable Tool (CAP ID + schemas + tests).

## Flow

1. Gap detection (planner cannot bind a CAP)
2. Compile AgentSpec (goal, inputs, environment, success, safety)
3. Run with appropriate runner (web/mobile/OS/API)
4. Pause for S3 approval when sensitive (accounts/$$)
5. Record artifacts, evidence (screenshots/DOM), and logs
6. Graduation: parameterize into ToolSpec with tests; open PR

## AgentSpec DSL (sketch)

```yaml
kind: web|mobile|os|api
goal: "Book flight Lagos→Dublin, Oct 12–26, 1 adult"
inputs: { origin: LOS, dest: DUB, dates: [2025-10-12, 2025-10-26], pax: 1 }
environment: { url: "https://www.skyscanner.com" }
constraints: ["budget<=1200USD", "avoid:red-eye"]
success: { require: ["itinerary.rows>=3", "price.exists"], outputs: ["itinerary", "price", "link"] }
safety: { max_steps: 120, max_runtime_s: 240, allow_domains: ["*.skyscanner.com"], approval: "S3" }
```

## Runners

- Web: DOM + accessibility tree + visual fallback; smart waits; screenshots/video; cookie isolation
- Mobile: emulator/simulator via driver; prefers accessibility IDs; OCR fallback
- OS: desktop automation sandbox with audit
- API Composer: plans multi-API sequences with retries and idempotency

## Exit criteria

- From a natural request without an existing tool, a micro-agent completes the task up to approvals and proposes a new tool (e.g., `travel.flight_book@1.0`) with tests.
