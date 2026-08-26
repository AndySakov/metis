# Web Memory v1

## Purpose

Keep a fresh, searchable corpus of public web knowledge aligned to user-selected feeds; provide hybrid search (BM25 ∪ vector) with provenance and sensible governance.

## Sources (seed)

- HN API/RSS
- arXiv/OpenAlex
- Telegram channels (scoped, with user approval)
- Generic RSS/Atom (blogs, news)

## Ingest pipeline

1. Scheduler (per-source rate limits, backoff)
2. Fetch (respect robots.txt and meta noindex)
3. Normalize (readability, site-specific rules)
4. Chunk (sentence/paragraph + heading context; optional statement-chaining)
5. Embed (managed API or self-hosted)
6. Deduplicate (simhash/minhash)
7. Index (BM25 + vector)
8. Verify claims, run fact checks and check hallucination score
9. Store (raw text + metadata + embeddings + provenance + claims validity)

## APIs (v1)

- GET `/web-memory/search` — query, filters → results with snippets + citations
- GET `/web-memory/answer` — query → concise answer + citations (optional LLM rerank)
- GET `/web-memory/feed` — “what changed” since timestamp (per source or all)

## Governance & safety

- Robots/noindex honored; per-source rate caps
- License tags on documents; takedown path
- Zero egress object storage optional; costs tracked per source

## Exit criteria

- ≥10 sources indexed with daily refresh
- Search returns cited results with provenance recorded as `artifact_provenance` links (ADR-013 dropped the dedicated graph store; provenance is relational)
- Weekly digest artifact summarizing new items per feed
