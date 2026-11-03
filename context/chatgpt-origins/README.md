# chatgpt-origins

Source material, not a plan. Most of METIS's early design happened in ChatGPT between June
and December 2025. This directory holds what came out of those conversations, so the record
lives next to the code.

**Authority:** none. Where anything here disagrees with `CLAUDE.md`, the ADRs, the specs or the
code, those win. Nothing here is a requirement until it has been turned into an ADR, a contract,
a test or code.

## What is here

| Path | What it is |
| --- | --- |
| `digest-metis-core.md` | What Temi asked for, compared with what the repo already has. Each item is tagged in-repo / partial / not-in-repo / conflicts. Also lists the assistant ideas worth keeping, the choices the ADRs replaced, and open questions. |
| `digest-mae.md` | The same for MAE (Modular Agent Ecosystem, network name Phantomgrid). MAE was a June 2025 protocol spec that came before METIS: agents and modules on an EVM L2. It covers how MAE relates to METIS, Temi's own decisions, and brain-spec ideas that still apply. |
| `manifest.json` | One entry per packaged conversation: ChatGPT id, title, dates, why it matters, file. |
| `transcripts/` | User and assistant turns along the final branch of each conversation. Tool calls and hidden reasoning are dropped. `## USER` is Temi. |
| `artifacts/` | Documents rebuilt from the chats. The MAE spec is the last copy ChatGPT read from the Cursor workspace. The roadmap and Phase 0 files were rebuilt by replaying ChatGPT's canvas edits. Their successors are in `docs/planning/`. |

## Known gaps

- `artifacts/mae-spec-draft-v1.md` is cut off inside §11.10. ChatGPT only ever saw a truncated
  copy. The full file was `mae/README.md` in a local workspace and is not included yet.
- The two monetization turns at the end of the imagineering conversation are left out of this
  public copy, along with the parts of the digest that drew on them.
- Conversations that are only nearby (the Stagehand research crawler, the truth-engine thought
  experiment, workstation and garage builds) are not packaged.

## Using it

Read the two digests first. Open a transcript when you need what Temi actually said; quotes in the
digests carry the transcript and turn. Any idea taken forward should go through an ADR, a contract
or a test like everything else.
