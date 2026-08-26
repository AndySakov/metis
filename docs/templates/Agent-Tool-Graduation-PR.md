# Agent → Tool Graduation PR

## Summary

- Promote successful micro-agent run to a reusable Tool.
- Capability: `domain.action@MAJOR.MINOR` (e.g., `travel.flight_book@1.0`).

## Motivation

- Describe the gap this agent filled and how the tool abstracts it.

## Proposed Tool

- CAP ID: `...`
- Name: `...`
- Version: `...`
- Input schema: `specs/capabilities/<cap>@<ver>.input.schema.json`
- Output schema: `specs/capabilities/<cap>@<ver>.output.schema.json`
- ToolSpec: `specs/tools/<tool>.tool.json`

## Evidence

- Screenshots/video: `artifacts/...`
- DOM snapshots/logs: `artifacts/...`
- Successful AgentSpec run: `specs/AgentSpec.example.yaml` (or link to run record)

## Tests

- [ ] Unit: schema validation
- [ ] Fixture replay: deterministic selectors/flows
- [ ] Sandbox run within budgets

## Safety & Policy

- Scopes required: `...`
- Approval level: S2/S3 (describe)
- Robots/ToS considerations: `...`

## Rollout

- Release plan: shadow → percent → full
- Backout: disable tool; revert version; keep agent fallback
