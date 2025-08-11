<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  export let open = false;
  export let plan: any = null;
  export let stepStatus: Array<{ stepId: string; status: string; ts: number }> =
    [];
  export let artifacts: any[] = [];
  export let trail: any[] = [];
  let previewId = "";
  let previewMeta: any = null;
  let previewMarkdown = "";
  let showLogs = false;
  let lastPlanId: string = "";
  $: if (open && plan?.id && plan.id !== lastPlanId) {
    // Reset logs toggle when showing a different plan or after reopen
    lastPlanId = plan.id;
    showLogs = false;
  }
  const dispatch = createEventDispatcher();
  import { badgeClass } from "../lib/ui";
  function renderMarkdown(md: string): string {
    const html = marked.parse(md ?? "");
    return DOMPurify.sanitize(String(html));
  }
</script>

{#if open}
  <div
    class="ds-modal-backdrop"
    role="button"
    tabindex="0"
    on:click={() => dispatch("close")}
    on:keydown={(e) => {
      if (e.key === "Enter" || e.key === " ") dispatch("close");
    }}
  ></div>
  <div class="ds-modal">
    <div class="ds-modal-header">
      <div class="modal-title">Plan: {plan?.goal || plan?.id}</div>
      <button on:click={() => dispatch("close")}>Close</button>
    </div>
    <div class="ds-modal-body">
      {#if plan}
        <div class="grid2">
          <div>
            <div><strong>Steps</strong></div>
            <ol>
              {#each plan.steps || [] as s}
                <li>
                  <span class={badgeClass("pending")}>{s.kind}</span>
                  {s.description}
                  {#if s.toolCall?.capability}<span style="color:var(--muted);">
                      · {s.toolCall.capability}</span
                    >{/if}
                </li>
              {/each}
            </ol>
            {#if stepStatus && stepStatus.length}
              <div class="mt8"><strong>Step Status</strong></div>
              <ul>
                {#each stepStatus as s}
                  <li>
                    <span class={badgeClass(s.status)}>{s.status}</span>
                    {s.stepId}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          <div>
            <div><strong>Artifacts</strong></div>
            {#if artifacts && artifacts.length}
              <ul>
                {#each artifacts as a}
                  <li>
                    {a.title} · {a.kind}
                    <button
                      class="link"
                      on:click={() => dispatch("preview", { id: a.id })}
                      >Preview</button
                    >
                  </li>
                {/each}
              </ul>
              {#if previewMarkdown}
                <div class="mt8">
                  <strong>Preview: {previewMeta?.title || previewId}</strong>
                </div>
                <div class="ds-md">
                  {@html renderMarkdown(previewMarkdown)}
                </div>
              {/if}
            {:else}
              <div class="muted">No artifacts yet</div>
            {/if}
            <div class="mt8">
              <button on:click={() => (showLogs = !showLogs)}
                >{showLogs ? "Hide" : "Show"} Execution Log</button
              >
            </div>
            {#if showLogs}
              <div class="log">
                {#each trail as e}
                  <div class="log-row">
                    <span class="log-ts">{e.ts}</span>
                    <span class="log-type">{e.type}</span>
                    {#if e.payload?.stepId}
                      <span class="log-meta">step {e.payload.stepId}</span>
                    {/if}
                    {#if e.payload?.artifactId}
                      <span class="log-meta"
                        >artifact {e.payload.artifactId}</span
                      >
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
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
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .muted {
    color: var(--muted);
  }
  .mt8 {
    margin-top: 8px;
  }
  .log {
    display: grid;
    grid-template-columns: 120px 180px 1fr;
    gap: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 8px;
    background: var(--panel-muted);
  }
  .log-row {
    display: contents;
  }
  .log-ts {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .log-type {
    color: var(--text);
    font-weight: 600;
  }
  .log-meta {
    color: var(--muted);
  }
  .md-preview {
    background: #0b1220;
    color: var(--muted);
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 10px;
  }
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
  .link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
  }
</style>
