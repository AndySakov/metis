<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import AdminHeader from "./components/AdminHeader.svelte";
  import HomeHero from "./components/HomeHero.svelte";
  import PlanModal from "./components/PlanModal.svelte";
  import HomeProgress from "./components/HomeProgress.svelte";
  const BASE = localStorage.getItem("metis_base") || "http://localhost:8080";
  let goal = "Draft a PRD for v1 test";
  let project = localStorage.getItem("metis_project") || "demo";
  // API key handled server-side; UI sends only the goal to mock-core
  let status = "";
  let plan: any = null;
  let events: any[] = [];
  let artifact: any = null;
  let artifactMarkdown: string = "";
  let report: any = null;
  let tools: any[] = [];
  let allPlans: any[] = [];
  let poll: any = null;
  let lastArtifactId: string = "";
  let lastExecution: { planId?: string; executionId?: string } = {};
  let showHomeProgress = false;
  let projects: string[] = [];
  let selectedPlanId: string = "";
  let selectablePlans: Array<{ id: string; title?: string }> = [];
  let executionTrail: any[] = [];
  let stepStatus: Array<{ stepId: string; status: string; ts: number }> = [];
  let planArtifacts: any[] = [];
  // Health snapshot
  let health: any = null;
  let newProject: string = "";
  // Vector/Graph demo state
  let vecCollection = "demo";
  let vecEmbedding = "0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8";
  let vecK = 5;
  let vecResults: any[] = [];
  let gFrom = "";
  let gRel = "";
  let gTo = "";
  let gEdges: any[] = [];
  // Policy management
  let policy: any = null;
  let policyAllowedCapsStr = "";
  let policyDeniedCapsStr = "";
  let policyRequireCapsStr = "";
  let policyAllowedScopesStr = "";
  let policyMaxBudgetSeconds: number = 0;
  let policyRequireAll = false;
  let sse: EventSource | null = null;
  let sseConnected = false;
  const seenEventIds = new Set<string>();
  let lastEventTs = 0;
  // Toasts
  type Toast = { id: string; kind: "info" | "error" | "success"; text: string };
  let toasts: Toast[] = [];
  let toolsValidation: any = null;
  // UI modes
  type UIMode = "home" | "admin";
  let mode: UIMode = (localStorage.getItem("metis_mode") as UIMode) || "home";
  function setMode(m: UIMode) {
    mode = m;
    localStorage.setItem("metis_mode", mode);
  }
  // Command palette state (home)
  let paletteText = "";
  const witty = [
    "How can I help you, Rogue?",
    "What shall we craft today?",
    "Your wish is my command. Literally.",
  ];
  let paletteInputEl: HTMLInputElement | null = null;
  // Plan modal (home)
  let showPlanModal = false;
  let modalPlan: any = null;
  let modalTrail: any[] = [];
  let modalArtifacts: any[] = [];
  let modalStepStatus: Array<{ stepId: string; status: string; ts: number }> =
    [];
  let showModalLogs = false;
  let modalPreviewId: string = "";
  let modalPreviewMarkdown: string = "";
  let modalPreviewMeta: any = null;
  // Markdown rendering moved to PlanModal
  // Admin event filters
  let eventSearch = "";
  let showEventFilters = false;
  const knownEventTypes = [
    "PLAN_CREATED",
    "EXECUTION_STARTED",
    "EXECUTION_COMPLETED",
    "TOOL_STARTED",
    "TOOL_COMPLETED",
    "TOOL_FAILED",
    "ARTIFACT_WRITTEN",
    "APPROVAL_REQUIRED",
    "APPROVAL_GRANTED",
    "APPROVAL_DENIED",
    "STEP_REJECTED",
    "STEP_SKIPPED",
  ];
  let enabledEventTypes = new Set<string>();
  let eventTypeEnabled: Record<string, boolean> = {};
  for (const t of knownEventTypes) eventTypeEnabled[t] = false;

  function recomputeEnabledEventTypes() {
    const next = new Set<string>();
    for (const t of knownEventTypes) if (eventTypeEnabled[t]) next.add(t);
    enabledEventTypes = next;
  }
  function addToast(text: string, kind: Toast["kind"] = "info", ms = 3000) {
    const id = `t_${Date.now()}_${Math.random()}`;
    toasts = [...toasts, { id, kind, text }];
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
    }, ms);
  }
  // UI busy flags
  let busyCreate = false;
  let busyExecute = false;
  let busyAI = false;
  // Collapsible sections
  let showExecution = true;
  let showEvents = true;
  let showArtifacts = true;
  let showVector = false;
  let showGraph = false;
  let showPolicy = false;
  // Helpers
  import { badgeClass, toolTip, pretty } from "./lib/ui";
  async function api(method: string, path: string, body?: any) {
    const url = path.includes("?")
      ? `${BASE}${path}&project=${encodeURIComponent(project)}`
      : `${BASE}${path}?project=${encodeURIComponent(project)}`;
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json();
  }

  async function createPlan() {
    status = "Creating plan...";
    busyCreate = true;
    try {
      const intent = {
        id: `intent_ui_${Date.now()}`,
        ts: new Date().toISOString(),
        actor: "user:demo",
        goal,
        autonomy: "S1",
        project,
      };
      plan = await api("POST", "/intent", intent);
      events = await api("GET", "/eventlog");
      status = "Plan created.";
      addToast("Plan created", "success");
    } catch (e) {
      console.error(e);
      status = "Error creating plan.";
      addToast("Failed to create plan. Is the mock server running?", "error");
    }
    busyCreate = false;
  }

  async function executePlan() {
    if (!plan?.id) return;
    status = "Executing plan...";
    busyExecute = true;
    report = await api("POST", `/plans/${plan.id}/execute`, {});
    // Track execution immediately
    try {
      if (report?.planId) {
        plan = await api("GET", `/plans/${report.planId}`);
      }
    } catch {}
    events = await api("GET", "/eventlog");
    lastExecution = {
      planId: report?.planId,
      executionId: report?.executionId,
    };
    status = "Execution started...";
    addToast("Execution started", "info");
    busyExecute = false;
  }

  async function aiPlan() {
    status = "Asking AI to draft a plan...";
    busyAI = true;
    // show progress immediately; executionId will be filled on response
    showHomeProgress = true;
    lastExecution = {};
    const res = await fetch(
      `${BASE}/ai/plan?project=${encodeURIComponent(project)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, project }),
      }
    );
    if (!res.ok) {
      addToast("AI error " + res.status, "error");
      status = "";
      busyAI = false;
      return;
    }
    report = await res.json();
    if (report?.planId) {
      try {
        plan = await api("GET", `/plans/${report.planId}`);
      } catch {}
    }
    if (!sseConnected) {
      events = await api("GET", "/eventlog");
    }
    lastExecution = {
      planId: report?.planId,
      executionId: report?.executionId,
    };
    status =
      report?.status === "started"
        ? "AI plan started..."
        : "AI plan completed.";
    addToast(status, "info");
    busyAI = false;
  }

  async function runPalette() {
    try {
      const prev = goal;
      goal = (paletteText || "").trim();
      if (!goal) return;
      await aiPlan();
      goal = prev;
      // refresh plans list so the new plan appears
      await refreshPlans();
    } catch {}
  }

  async function openPlanModal(id: string) {
    try {
      modalPlan = await api("GET", `/plans/${id}`);
    } catch {}
    try {
      modalArtifacts = await api("GET", `/plans/${id}/artifacts`);
    } catch {
      modalArtifacts = [];
    }
    try {
      modalTrail = await api("GET", `/plans/${id}/trail?limit=50`);
    } catch {
      modalTrail = [];
    }
    try {
      modalStepStatus = await api("GET", `/plans/${id}/status`);
    } catch {
      modalStepStatus = [];
    }
    showModalLogs = false;
    modalPreviewId = "";
    modalPreviewMarkdown = "";
    modalPreviewMeta = null;
    showPlanModal = true;
  }

  async function refreshEvents() {
    events = await api("GET", "/eventlog");
  }

  async function refreshTools() {
    tools = await api("GET", "/tools");
  }

  async function validateTools() {
    try {
      // Validate all example tools one-by-one and aggregate results
      const arr: any[] = [];
      for (const t of tools) {
        const res = await fetch(
          `${BASE}/tools/validate?project=${encodeURIComponent(project)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(t),
          }
        );
        const r = await res.json();
        arr.push({
          capability: t.capability,
          valid: r.valid,
          errors: r.errors || [],
          tests: r.testResults || [],
        });
      }
      toolsValidation = arr;
      const invalid = arr.filter((x) => !x.valid).length;
      addToast(
        invalid ? `${invalid} tool(s) invalid` : `All tools valid`,
        invalid ? "error" : "success"
      );
    } catch (e) {
      addToast("Validation failed", "error");
    }
  }

  async function refreshPlans() {
    try {
      allPlans = await api("GET", "/plans");
      selectablePlans = allPlans.map((p: any) => ({
        id: p.id,
        title: p.goal || p.id,
      }));
      if (!selectedPlanId && allPlans.length) {
        selectedPlanId = allPlans[allPlans.length - 1].id;
        try {
          plan = await api("GET", `/plans/${selectedPlanId}`);
        } catch {}
      }
    } catch (e) {
      console.error("Failed to load plans", e);
    }
  }

  async function refreshHealth() {
    try {
      health = await api("GET", "/healthz");
    } catch {}
  }

  async function refreshProjects() {
    try {
      projects = await api("GET", "/projects");
      if (project && !projects.includes(project)) {
        projects = [project, ...projects];
      }
    } catch (e) {
      // ignore
    }
  }

  async function refreshPlanIfSet() {
    if (plan?.id) {
      try {
        plan = await api("GET", `/plans/${plan.id}`);
      } catch {}
      // load server-side execution trail for the plan
      try {
        executionTrail = await api("GET", `/plans/${plan.id}/trail?limit=50`);
      } catch {}
      // load per-step status
      try {
        stepStatus = await api("GET", `/plans/${plan.id}/status`);
      } catch {}
      // load artifacts for this plan
      try {
        planArtifacts = await api("GET", `/plans/${plan.id}/artifacts`);
      } catch {}
    }
  }

  async function refreshAll() {
    try {
      // fetch latest events if SSE not connected to reduce flicker
      let evts = events;
      if (!sseConnected) {
        // Incremental fetch by lastEventTs to reduce payload and flicker
        const url = `${BASE}/eventlog?project=${encodeURIComponent(project)}${
          lastEventTs ? `&fromTs=${lastEventTs}` : ""
        }`;
        try {
          const r = await fetch(url);
          if (r.ok) {
            const data = await r.json();
            if (Array.isArray(data) && data.length) {
              evts = [...events, ...data].slice(-300);
              events = evts;
              const maxTs = Math.max(
                lastEventTs,
                ...data.map((d: any) => (typeof d?.ts === "number" ? d.ts : 0))
              );
              if (maxTs > lastEventTs) lastEventTs = maxTs;
            }
          }
        } catch {}
      }
      // Build an execution trail for the current plan
      if (plan?.id) {
        executionTrail = evts
          .filter((e: any) => {
            const p = e?.payload || {};
            return (
              p.planId === plan.id ||
              (e.type === "ARTIFACT_WRITTEN" && p.artifactId)
            );
          })
          .slice(-25);
      } else {
        executionTrail = [];
      }
      // Update status if we see completion for the last execution
      if (lastExecution?.executionId) {
        const done = [...evts]
          .reverse()
          .find(
            (e: any) =>
              e.type === "EXECUTION_COMPLETED" &&
              e.payload?.executionId === lastExecution.executionId
          );
        if (done) {
          status =
            done.payload?.status === "failed"
              ? "Execution failed."
              : "Execution complete.";
        }
      }
      // artifact discovery (newest)
      const artEvt = [...evts]
        .reverse()
        .find((e: any) => e.type === "ARTIFACT_WRITTEN");
      const newId = artEvt?.payload?.artifactId;
      if (newId && newId !== lastArtifactId) {
        lastArtifactId = newId;
        artifact = await api("GET", `/artifacts/${newId}`);
        const res = await fetch(`${BASE}/artifacts/${newId}/content`);
        artifactMarkdown = res.ok ? await res.text() : "";
      }
    } catch {}
    // keep plans and selected plan up to date
    refreshPlans();
    refreshPlanIfSet();
  }

  onMount(() => {
    refreshEvents();
    refreshTools();
    refreshPlans();
    refreshHealth();
    refreshProjects();
    refreshPolicy();
    poll = setInterval(refreshAll, 1000);
    // SSE stream for low-latency updates
    try {
      sse = new EventSource(`${BASE}/events/stream`);
      sse.onerror = () => {
        sseConnected = false;
        addToast("Event stream disconnected", "error", 4000);
      };
      sse.onopen = () => {
        sseConnected = true;
        addToast("Event stream connected", "success", 1500);
      };
      sse.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data);
          const id = String(e?.id || "");
          if (id && seenEventIds.has(id)) return;
          if (id) {
            seenEventIds.add(id);
            if (seenEventIds.size > 600) {
              // trim oldest seen ids occasionally
              const toDrop = seenEventIds.size - 600;
              let i = 0;
              for (const v of seenEventIds) {
                seenEventIds.delete(v);
                if (++i >= toDrop) break;
              }
            }
          }
          events = [...events, e].slice(-300);
          if (typeof e?.ts === "number" && e.ts > lastEventTs)
            lastEventTs = e.ts;
          if (e.type === "ARTIFACT_WRITTEN") {
            const id = e?.payload?.artifactId;
            if (id && id !== lastArtifactId) {
              lastArtifactId = id;
              (async () => {
                artifact = await api("GET", `/artifacts/${id}`);
                const res = await fetch(`${BASE}/artifacts/${id}/content`);
                artifactMarkdown = res.ok ? await res.text() : "";
              })();
            }
          }
        } catch {}
      };
    } catch {}
    // Cmd/Ctrl+K focuses command palette (home)
    const onKey = (e: KeyboardEvent) => {
      const isK = (e.key || "").toLowerCase() === "k";
      if ((e.metaKey || e.ctrlKey) && isK) {
        e.preventDefault();
        if (mode === "home" && paletteInputEl) paletteInputEl.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  onDestroy(() => {
    if (poll) clearInterval(poll);
    if (sse) sse.close();
  });

  function toArray(s: string): string[] {
    return s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }

  async function refreshPolicy() {
    try {
      policy = await api("GET", "/policy");
      policyAllowedCapsStr = Array.isArray(policy?.allowedCapabilities)
        ? policy.allowedCapabilities.join(", ")
        : "";
      policyDeniedCapsStr = Array.isArray(policy?.deniedCapabilities)
        ? policy.deniedCapabilities.join(", ")
        : "";
      policyRequireCapsStr = Array.isArray(policy?.requireApprovalCapabilities)
        ? policy.requireApprovalCapabilities.join(", ")
        : "";
      policyAllowedScopesStr = Array.isArray(policy?.allowedAuthScopes)
        ? policy.allowedAuthScopes.join(", ")
        : "";
      policyMaxBudgetSeconds = Number(policy?.maxBudgetSeconds || 0);
      policyRequireAll = !!policy?.requireApprovalAll;
    } catch (e) {
      console.error("Failed to load policy", e);
    }
  }

  async function savePolicy() {
    try {
      const body = {
        allowedCapabilities: toArray(policyAllowedCapsStr),
        deniedCapabilities: toArray(policyDeniedCapsStr),
        requireApprovalCapabilities: toArray(policyRequireCapsStr),
        allowedAuthScopes: toArray(policyAllowedScopesStr),
        maxBudgetSeconds: Number(policyMaxBudgetSeconds) || 0,
        requireApprovalAll: !!policyRequireAll,
      };
      await api("POST", "/policy", body);
      await refreshPolicy();
      status = "Policy saved";
    } catch (e) {
      alert("Failed to save policy");
    }
  }

  async function runVectorSearch() {
    try {
      const embedding = vecEmbedding
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      vecResults = await api("POST", "/vectors/search", {
        collection: vecCollection,
        embedding,
        k: vecK,
      });
    } catch (e) {
      alert("Vector search failed");
    }
  }

  async function runGraphQuery() {
    try {
      gEdges = await api("POST", "/graph/query", {
        from: gFrom || undefined,
        rel: gRel || undefined,
        to: gTo || undefined,
      });
    } catch (e) {
      alert("Graph query failed");
    }
  }

  async function previewArtifact(id: string) {
    try {
      artifact = await api("GET", `/artifacts/${id}`);
      const res = await fetch(`${BASE}/artifacts/${id}/content`);
      artifactMarkdown = res.ok ? await res.text() : "";
    } catch {}
  }

  async function approveStep(stepId: string, allow: boolean) {
    if (!plan?.id) return;
    try {
      await api(
        "POST",
        allow
          ? `/plans/${plan.id}/approve/${stepId}`
          : `/plans/${plan.id}/deny/${stepId}`
      );
      await refreshPlanIfSet();
    } catch (e) {
      alert("Approval action failed");
    }
  }

  async function previewModalArtifact(id: string) {
    try {
      modalPreviewMeta = await api("GET", `/artifacts/${id}`);
      const res = await fetch(`${BASE}/artifacts/${id}/content`);
      modalPreviewMarkdown = res.ok ? await res.text() : "";
      modalPreviewId = id;
    } catch {
      modalPreviewMarkdown = "";
    }
  }
</script>

{#if mode === "admin"}
  <AdminHeader
    bind:project
    {projects}
    on:projectChange={() => {
      localStorage.setItem("metis_project", project);
      refreshPlans();
      refreshEvents();
    }}
    on:refreshTools={refreshTools}
    on:refreshEvents={refreshEvents}
    on:goHome={() => setMode("home")}
  />
{/if}
{#if mode === "admin"}
  <div class="status">{status}</div>
  {#if health}
    <div class="status">
      health: plans {health.plans}, tools {health.tools}, events {health.events}
    </div>
  {/if}
{/if}
{#if toasts.length}
  <div class="toasts">
    {#each toasts as t}
      <div class={`toast ${t.kind}`}>{t.text}</div>
    {/each}
  </div>
{/if}
{#if mode === "home"}
  <HomeHero
    {witty}
    bind:project
    {projects}
    bind:newProject
    bind:paletteText
    {busyAI}
    {allPlans}
    on:projectChange={() => {
      localStorage.setItem("metis_project", project);
      refreshPlans();
      refreshEvents();
    }}
    on:createProject={(e) => {
      const v = String(e.detail?.title || "").trim();
      if (v) {
        project = v;
        localStorage.setItem("metis_project", project);
        refreshProjects();
        refreshPlans();
        newProject = "";
      }
    }}
    on:runCommand={() => runPalette()}
    on:openPlan={(e) => openPlanModal(String(e.detail?.id))}
    on:openAdmin={() => setMode("admin")}
  />
{/if}

{#if mode === "home"}
  <!-- Live progress during AI execution -->
  {#key lastExecution?.executionId}
    <HomeProgress
      open={showHomeProgress}
      {events}
      goal={paletteText || goal}
      planId={lastExecution?.planId || plan?.id}
      executionId={lastExecution?.executionId || ""}
      on:done={() => {
        showHomeProgress = false;
        if (lastExecution?.planId) {
          openPlanModal(lastExecution.planId);
        }
      }}
    />
  {/key}
{/if}

{#if mode === "admin"}
  <main>
    <section class="card">
      <h2>Plan</h2>
      <div
        style="display:flex; gap:8px; align-items:center; margin-bottom:8px;"
      >
        <label for="plan-select">View plan:</label>
        <select
          id="plan-select"
          bind:value={selectedPlanId}
          on:change={async () => {
            if (selectedPlanId) {
              try {
                plan = await api("GET", `/plans/${selectedPlanId}`);
              } catch {}
              await refreshPlanIfSet();
            }
          }}
        >
          {#each selectablePlans as p}
            <option value={p.id}>{p.title || p.id}</option>
          {/each}
        </select>
      </div>
      {#if plan}
        <div class="plan-view">
          <div><strong>Goal:</strong> {plan.goal}</div>
          {#if plan.steps && plan.steps.length}
            <div class="mt8"><strong>Steps</strong></div>
            <ol>
              {#each plan.steps as s}
                <li>
                  <span class={badgeClass("pending")}>{s.kind}</span>
                  {s.description}
                  {#if s.toolCall?.capability}
                    <span style="color:var(--muted);">
                      · {s.toolCall.capability}</span
                    >
                  {/if}
                </li>
              {/each}
            </ol>
          {/if}
          {#if plan.assumptions && plan.assumptions.length}
            <div class="mt8"><strong>Assumptions</strong></div>
            <ul>
              {#each plan.assumptions as a}<li>{a}</li>{/each}
            </ul>
          {/if}
          {#if plan.risks && plan.risks.length}
            <div class="mt8"><strong>Risks</strong></div>
            <ul>
              {#each plan.risks as r}<li>{r}</li>{/each}
            </ul>
          {/if}
        </div>
      {/if}
    </section>
    <section class="card">
      <h2>All Plans ({allPlans.length})</h2>
      <button on:click={refreshPlans}>Refresh Plans</button>
      <ul>
        {#each allPlans.slice(-8).reverse() as p}
          <li>
            {p.goal || p.id}
            <button
              style="margin-left:8px;"
              on:click={() => {
                selectedPlanId = p.id;
                (async () => {
                  try {
                    plan = await api("GET", `/plans/${p.id}`);
                  } catch {}
                  await refreshPlanIfSet();
                })();
              }}>Open</button
            >
          </li>
        {/each}
      </ul>
    </section>
    <section class="card">
      <h2>Tools ({tools.length})</h2>
      <div
        style="display:flex; gap:8px; align-items:center; margin-bottom:8px;"
      >
        <button on:click={validateTools}>Validate Tools</button>
      </div>
      <ul>
        {#each tools as t}
          <li title={toolTip(t)}>
            <strong>{t.capability}</strong>{t.tool ? ` – ${t.tool}` : ""}
          </li>
        {/each}
      </ul>
      {#if toolsValidation}
        <h3>Validation</h3>
        <ul>
          {#each toolsValidation as r}
            <li>
              <span class={badgeClass(r.valid ? "completed" : "failed")}>
                {r.valid ? "valid" : "invalid"}
              </span>
              {r.capability}
              {#if r.errors && r.errors.length}
                <pre>{r.errors.join("\n")}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
    <section class="card">
      <h2>Execution</h2>
      {#if stepStatus.length}
        <h3>Step Status</h3>
        <ul>
          {#each stepStatus as s}
            <li>
              <span class={badgeClass(s.status)}>{s.status}</span> — {s.stepId}
              {#if s.status === "awaiting_approval"}
                <button
                  on:click={() => approveStep(s.stepId, true)}
                  style="margin-left:8px;">Approve</button
                >
                <button
                  on:click={() => approveStep(s.stepId, false)}
                  style="margin-left:6px;">Deny</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if executionTrail.length}
        <h3>Trail</h3>
        <ul>
          {#each executionTrail as e}
            <li>
              {e.ts} · {e.type} · {e.payload?.planId || ""}
              {e.payload?.stepId ? `(step ${e.payload.stepId})` : ""}
              {e.payload?.artifactId
                ? `(artifact ${e.payload.artifactId})`
                : ""}
            </li>
          {/each}
        </ul>
      {/if}
      {#if report?.stepResults}
        <ul>
          {#each report.stepResults as s}
            <li>
              <strong>{s.stepId}</strong>: {s.status}
              {#if s.output?.artifactId}
                (artifact: {s.output.artifactId}){/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
    <section class="card">
      <h2>Events</h2>
      <div class="events-controls">
        <button on:click={() => (showEventFilters = !showEventFilters)}>
          {showEventFilters ? "Hide" : "Show"} Filters
        </button>
        <input
          placeholder="search events"
          bind:value={eventSearch}
          style="margin-left:8px; width:220px;"
        />
      </div>
      {#if showEventFilters}
        <div class="events-filters">
          {#each knownEventTypes as t}
            <label>
              <input
                type="checkbox"
                bind:checked={eventTypeEnabled[t]}
                on:change={recomputeEnabledEventTypes}
              />
              {t}
            </label>
          {/each}
        </div>
      {/if}
      <ul>
        {#each events
          .filter((e) => enabledEventTypes.size === 0 || enabledEventTypes.has(e.type))
          .filter((e) => !eventSearch || JSON.stringify(e)
                .toLowerCase()
                .includes(eventSearch.toLowerCase()))
          .slice(-50) as e}
          <li>
            {e.ts} · <strong>{e.type}</strong> · {e.payload?.planId || ""}
            {e.payload?.stepId ? `(step ${e.payload.stepId})` : ""}
            {e.payload?.artifactId ? `(artifact ${e.payload.artifactId})` : ""}
          </li>
        {/each}
      </ul>
    </section>
    <section class="card">
      <h2>Artifacts</h2>
      {#if planArtifacts.length}
        <ul>
          {#each planArtifacts as a}
            <li>
              <button on:click={() => previewArtifact(a.id)}>Preview</button>
              {a.id} · {a.title} · {a.kind}
            </li>
          {/each}
        </ul>
      {/if}
      <pre>{artifact ? pretty(artifact) : ""}</pre>
      {#if artifactMarkdown}
        <h3>Artifact Preview</h3>
        <pre>{artifactMarkdown}</pre>
      {/if}
    </section>

    <section class="card">
      <h2>Vector Search</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input
          bind:value={vecCollection}
          placeholder="collection"
          style="width:140px;"
        />
        <input
          bind:value={vecEmbedding}
          placeholder="embedding comma-separated"
          style="flex:1; min-width:220px;"
        />
        <input
          bind:value={vecK}
          type="number"
          min="1"
          step="1"
          style="width:80px;"
        />
        <button on:click={runVectorSearch}>Search</button>
      </div>
      <pre>{vecResults && vecResults.length ? pretty(vecResults) : ""}</pre>
    </section>

    <section class="card">
      <h2>Graph Query</h2>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input bind:value={gFrom} placeholder="from" style="width:160px;" />
        <input bind:value={gRel} placeholder="rel" style="width:140px;" />
        <input bind:value={gTo} placeholder="to" style="width:160px;" />
        <button on:click={runGraphQuery}>Query</button>
      </div>
      <pre>{gEdges && gEdges.length ? pretty(gEdges) : ""}</pre>
    </section>

    <section class="card">
      <h2>Policy Management</h2>
      <div
        style="display:grid; grid-template-columns: 180px 1fr; gap:8px; align-items:center;"
      >
        <label for="p-allow">Allowed Capabilities</label>
        <input
          id="p-allow"
          bind:value={policyAllowedCapsStr}
          placeholder="*, design.prd@1.0, research.*"
        />
        <label for="p-deny">Denied Capabilities</label>
        <input id="p-deny" bind:value={policyDeniedCapsStr} placeholder="" />
        <label for="p-reqcaps">Require Approval (caps)</label>
        <input
          id="p-reqcaps"
          bind:value={policyRequireCapsStr}
          placeholder="design.prd@1.0"
        />
        <label for="p-scopes">Allowed Auth Scopes</label>
        <input
          id="p-scopes"
          bind:value={policyAllowedScopesStr}
          placeholder="* or public.web, internal.api"
        />
        <label for="p-max">Max Budget Seconds</label>
        <input
          id="p-max"
          type="number"
          min="0"
          bind:value={policyMaxBudgetSeconds}
        />
        <label for="p-all">Require Approval For All</label>
        <input id="p-all" type="checkbox" bind:checked={policyRequireAll} />
      </div>
      <div style="margin-top:8px; display:flex; gap:8px;">
        <button on:click={savePolicy}>Save Policy</button>
        <button on:click={refreshPolicy}>Reload</button>
      </div>
      <pre style="margin-top:8px;">{policy ? pretty(policy) : ""}</pre>
    </section>
  </main>
{/if}

{#if showPlanModal}
  <PlanModal
    open={showPlanModal}
    plan={modalPlan}
    stepStatus={modalStepStatus}
    artifacts={modalArtifacts}
    trail={modalTrail}
    on:close={() => {
      showPlanModal = false;
      lastExecution = {};
      showHomeProgress = false;
    }}
    on:preview={(e) => previewModalArtifact(String(e.detail?.id))}
  />
{/if}

<style>
  :root {
    --bg: #0b0f14;
    --panel: #0f1621;
    --text: #dfe7ef;
    --muted: #94a3b8;
    --accent: #6ea8ff;
  }
  :global(body) {
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      Segoe UI,
      Roboto,
      sans-serif;
    margin: 0;
    background: var(--bg);
    color: var(--text);
  }
  /* header, h1, and .controls moved to AdminHeader.svelte */
  .spacer {
    flex: 1;
  }
  .status {
    padding: 6px 20px;
    color: var(--muted);
    font-size: 12px;
  }
  main {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
    padding: 16px 20px;
  }
  .hero {
    display: grid;
    place-items: center;
    height: calc(100vh - 70px);
  }
  .hero-inner {
    text-align: center;
    max-width: 820px;
    padding: 0 20px;
  }
  .hero-title {
    font-size: 28px;
    margin-bottom: 8px;
  }
  .witty {
    color: var(--muted);
    font-size: 14px;
    margin-top: 4px;
  }
  .hero-sub {
    color: var(--muted);
    margin-bottom: 18px;
  }
  .home-block {
    margin-top: 18px;
    padding: 16px;
    border: 1px solid #1e293b;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.02);
    max-width: 820px;
  }
  .palette {
    display: flex;
    gap: 10px;
    justify-content: center;
  }
  /* palette input width lives in HomeHero */
  .suggestions {
    margin-top: 18px;
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .pill {
    border-radius: 999px;
    padding: 6px 10px;
  }
  .chip {
    border-radius: 999px;
    padding: 6px 10px;
    background: #0b1220;
    border: 1px solid #1e293b;
    color: var(--text);
    cursor: pointer;
  }
  .hero-footer {
    margin-top: 16px;
    color: var(--muted);
    font-size: 12px;
  }
  .project-switcher {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    margin-bottom: 12px;
  }
  .plans-dropdown {
    margin-top: 12px;
  }
  /* plans list layout moved to HomeHero */
  .link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
  }
  .muted {
    color: var(--muted);
  }
  .mt8 {
    margin-top: 8px;
  }
  .plan-view ol,
  .plan-view ul {
    margin: 6px 0 0 16px;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
  }
  .modal {
    position: fixed;
    top: 10%;
    left: 50%;
    transform: translateX(-50%);
    width: min(900px, 92vw);
    background: var(--panel);
    border: 1px solid #1e293b;
    border-radius: 10px;
    box-shadow: 0 2px 20px rgba(0, 0, 0, 0.5);
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #1e293b;
  }
  .modal-title {
    font-weight: 600;
  }
  .modal-body {
    padding: 12px;
    max-height: 70vh;
    overflow: auto;
  }
  .events-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .events-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 8px;
  }
  .md-preview {
    background: #0b1220;
    color: var(--muted);
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 10px;
  }
  .card {
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 12px;
    background: var(--panel);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  }
  pre {
    white-space: pre-wrap;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.4;
  }
  input {
    padding: 8px 10px;
    width: 320px;
    border-radius: 8px;
    border: 1px solid #1e293b;
    background: #0b1220;
    color: var(--text);
  }
  button {
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid #1e293b;
    background: #0b1220;
    color: var(--text);
    cursor: pointer;
  }
  button:hover {
    border-color: var(--accent);
  }
  /* badges and toasts */
  .badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 11px;
    margin-right: 6px;
    border: 1px solid #1e293b;
  }
  .badge-ok {
    background: #0f2a1a;
    color: #9ae6b4;
    border-color: #21523b;
  }
  .badge-err {
    background: #2a0f14;
    color: #feb2b2;
    border-color: #52213b;
  }
  .badge-run {
    background: #0f1f2a;
    color: #90cdf4;
    border-color: #214052;
  }
  .badge-wait {
    background: #2a2910;
    color: #faf089;
    border-color: #525021;
  }
  .badge-skip {
    background: #1f2733;
    color: #cbd5e0;
    border-color: #334155;
  }
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
  }
  .toast {
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid #1e293b;
    background: #0b1220;
    color: var(--text);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .toast.success {
    border-color: #21523b;
  }
  .toast.error {
    border-color: #52213b;
  }
  .toast.info {
    border-color: #214052;
  }
</style>
