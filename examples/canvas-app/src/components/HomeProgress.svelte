<script lang="ts">
  import { createEventDispatcher } from "svelte";
  export let open: boolean = false;
  export let goal: string = "";
  export let planId: string = "";
  export let executionId: string = "";
  export let events: any[] = [];
  // Allow showing panel before executionId is known; consider latest EXECUTION_STARTED as a hint
  $: hintedExec = !executionId
    ? [...(Array.isArray(events) ? events : [])]
        .reverse()
        .find((e) => e?.type === "EXECUTION_STARTED")?.payload?.executionId ||
      ""
    : executionId;

  const dispatch = createEventDispatcher<{ done: { status: string } }>();

  $: relevant = (Array.isArray(events) ? events : []).filter((e) => {
    const p = e?.payload || {};
    if (p?.executionId && hintedExec && p.executionId === hintedExec)
      return true;
    if (p?.planId && planId && p.planId === planId) return true;
    if (e?.type === "ARTIFACT_WRITTEN" && p?.artifactId) return true;
    return false;
  });

  let notifiedFor: string = "";
  $: completion = [...relevant]
    .reverse()
    .find(
      (e) =>
        e?.type === "EXECUTION_COMPLETED" &&
        e?.payload?.executionId === hintedExec
    );

  $: if (open && hintedExec && completion && notifiedFor !== hintedExec) {
    notifiedFor = hintedExec;
    const status = completion?.payload?.status || "completed";
    dispatch("done", { status });
  }

  function small(e: any): string {
    try {
      if (!e) return "";
      const t = e.type || "event";
      const p = e.payload || {};
      if (t === "EXECUTION_STARTED") return `Execution started`;
      if (t === "TOOL_STARTED")
        return `Tool started: ${p?.capability || p?.tool || "tool"}`;
      if (t === "TOOL_COMPLETED")
        return `Tool completed: ${p?.capability || p?.tool || "tool"}`;
      if (t === "TOOL_FAILED")
        return `Tool failed: ${p?.capability || p?.tool || "tool"}`;
      if (t === "ARTIFACT_WRITTEN")
        return `Artifact saved: ${String(p?.artifactId).slice(0, 8)}`;
      if (t === "EXECUTION_COMPLETED")
        return `Execution ${p?.status || "completed"}`;
      return t;
    } catch {
      return "event";
    }
  }
</script>

{#if open}
  <div class="ds-card" style="margin-top: 12px;">
    <div style="display: flex; align-items: center; gap: 12px;">
      <div class="ds-spinner" aria-label="loading" />
      <div>
        <div style="font-weight:600;">Working on it…</div>
        {#if goal}
          <div class="muted" style="margin-top:2px;">Goal: {goal}</div>
        {/if}
        {#if planId}
          <div class="muted" style="margin-top:2px;">Plan: {planId}</div>
        {/if}
      </div>
      <div style="flex:1" />
    </div>
    <div style="margin-top: 12px; max-height: 220px; overflow:auto;">
      {#if relevant.length === 0}
        <div class="muted">Waiting for events…</div>
      {:else}
        {#each relevant.slice(-12) as e}
          <div
            style="display:flex; align-items:center; gap:8px; margin: 6px 0;"
          >
            <span class="badge badge-run">{e.type}</span>
            <span class="muted">{small(e)}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .muted {
    color: var(--muted);
  }
</style>
