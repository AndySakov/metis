# LangChain vs Vercel SDK
_date: 2025-10-19 · id: 68f4c44e-8b58-8333-ad33-4e9138230419_

## USER

LangChain vs. Vercel AI SDK (pick the best option among those two and any other possible options)

## ASSISTANT

Short answer: **pick LangGraph (LangChain) as your core orchestration layer**—and pair it with a thin provider layer (Vercel **AI Gateway** or **LiteLLM**) and, if you need a UI, Vercel **AI SDK** on the front end.

### Why LangGraph wins for the core
- **Durable, long-running agents & workflows.** Built-in persistence lets runs resume after failures or delays; it’s designed for branching, loops, multi-agent graphs, memory, and human-in-the-loop control. citeturn2search3turn2search1turn2search7  
- **Production observability & evals via LangSmith.** First-class tracing, testing, and monitoring—framework-agnostic if you ever mix in other libs. citeturn0search0turn0search25  
- **Right tool for agentic complexity.** Even LangChain’s docs steer simple chains to LCEL and complex stateful/branching systems to LangGraph. citeturn0search20

### Where Vercel AI SDK shines (use it for UI/transport)
- **Excellent TS developer experience** for streaming, structured outputs (`generateObject`/`streamObject` with Zod/JSON schema), tool calling, and MCP tool access. Great for React/Next apps and fast prototypes. citeturn2search6turn3search0turn1view0turn3search1  
- **Model routing & reliability with AI Gateway** (budgeting, fallbacks, analytics), works with AI SDK *or* any OpenAI-compatible client. citeturn2search0turn2search8turn2search18

### Other solid pieces you may want to slot in
- **LiteLLM Proxy** if you prefer a self-hosted, OpenAI-compatible multi-provider gateway (can even front Vercel’s Gateway). citeturn0search4turn0search9  
- **LlamaIndex** if your focus is RAG/knowledge workflows or their newer “Agentic Document Workflows.” It plays fine alongside LangGraph. citeturn0search7turn0search17  
- **PydanticAI** (Python) if you ever need strongly-typed, durable agents in Py—nice ergonomics, but less relevant if you’re TS-first. citeturn0search3turn0search8

---

## My recommendation for you
Given your TS/NestJS bias and that **METIS** needs robust, stateful, tool-using agents:

1) **Core orchestration:** **LangGraph (JS)** for agent graphs, memory, retries, human gates, and durable execution. citeturn2search3  
2) **Provider layer:** **Vercel AI Gateway** (managed, great DX) *or* **LiteLLM Proxy** (self-host, OpenAI-compatible). Either keeps models swappable. citeturn2search0turn2search8turn0search4  
3) **Frontend/UI:** **Vercel AI SDK** (`useChat`, streaming, structured outputs, MCP tools) if you’re shipping a web UI. citeturn1view0turn3search0  
4) **Observability/evals:** **LangSmith** for traces, evals, and regression testing as you iterate. citeturn0search25  
5) **RAG (optional):** Add **LlamaIndex** if you want their indexing/workflows on top of your data. citeturn0search7

### TL;DR
- **Pick LangGraph** as “the best option” for the **core** (it gives you the reliability and control METIS needs).  
- Use **AI SDK** where it’s best—**UI/transport** and rapid TS integrations.  
- Add **AI Gateway/LiteLLM** for model abstraction, and **LangSmith** for production hygiene.

This combo gives you **durability + observability + speed of iteration** without locking you into any one model provider.

