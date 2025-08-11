<script lang="ts">
  import { createEventDispatcher } from "svelte";
  export let witty: string[] = [];
  export let project: string;
  export let projects: string[] = [];
  export let newProject: string = "";
  export let paletteText: string = "";
  export let busyAI: boolean = false;
  export let allPlans: any[] = [];
  let paletteInputEl: HTMLInputElement | null = null;
  const dispatch = createEventDispatcher();
</script>

<section class="hero">
  <div class="hero-inner">
    <div class="hero-title">
      <div>Hello, I'm <strong>Metis</strong>.</div>
      <div class="witty">
        {witty[Math.floor(Date.now() / 5000) % (witty.length || 1)]}
      </div>
    </div>
    <div class="hero-sub">
      Type a command and I'll draft a plan, run tools, and show receipts.
    </div>
    <div class="home-block">
      <div class="project-switcher">
        <label for="proj">Project:</label>
        <select
          class="ds-select"
          id="proj"
          bind:value={project}
          on:change={() => dispatch("projectChange", { project })}
        >
          {#each projects as pr}
            <option value={pr}>{pr}</option>
          {/each}
        </select>
        <input
          class="ds-input"
          bind:value={newProject}
          placeholder="Project Title"
          style="width:160px;"
          on:keydown={(e) => {
            if (e.key === "Enter")
              dispatch("createProject", { title: newProject });
          }}
        />
        <button
          class="ds-btn"
          on:click={() => dispatch("createProject", { title: newProject })}
          >Create</button
        >
      </div>
      <div class="palette" style="margin-top:12px;">
        <input
          class="ds-input"
          bind:value={paletteText}
          placeholder="e.g., Draft a PRD for the Widget v1"
          on:keydown={(e) => {
            if (e.key === "Enter")
              dispatch("runCommand", { text: paletteText });
          }}
          bind:this={paletteInputEl}
        />
        <button
          class="ds-btn"
          on:click={() => dispatch("runCommand", { text: paletteText })}
          disabled={busyAI}>Run</button
        >
      </div>
    </div>
    {#if allPlans && allPlans.length}
      <div class="plans-dropdown">
        <label for="plans-in-proj">Recent plans in {project}:</label>
        <ul id="plans-in-proj" class="plans-list">
          {#each allPlans.slice(-6).reverse() as p}
            <li>
              <button
                class="ds-chip"
                on:click={() => dispatch("openPlan", { id: p.id })}
                >{p.goal || p.id}</button
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <div class="suggestions">
      <button
        class="ds-pill"
        on:click={() => (paletteText = "Draft a PRD for a research summarizer")}
        >Draft a PRD</button
      >
      <button
        class="ds-pill"
        on:click={() =>
          (paletteText =
            "Summarize the latest on retrieval augmented generation")}
        >Summarize topic</button
      >
      <button
        class="ds-pill"
        on:click={() =>
          (paletteText = "Map claims and sources for LLM context windows")}
        >Make a claim graph</button
      >
    </div>
    <div class="hero-footer">
      Working in project <strong>{project}</strong>.
      <button class="link" on:click={() => dispatch("openAdmin")}
        >Switch to Admin</button
      >
    </div>
  </div>
</section>

<style>
  .hero {
    display: grid;
    place-items: center;
    height: calc(100vh - 70px);
  }
  .hero-inner {
    text-align: center;
    max-width: 820px;
    padding: 0 20px 32px 20px;
  }
  .hero-title {
    font-size: 30px;
    margin-bottom: 10px;
  }
  .witty {
    color: var(--muted);
    font-size: 14px;
    margin-top: 6px;
  }
  .hero-sub {
    color: var(--muted);
    margin-bottom: 20px;
  }
  .home-block {
    margin-top: 22px;
    padding: 18px 16px;
    border: 1px solid #1e293b;
    border-radius: 14px;
    background: linear-gradient(
      180deg,
      rgba(16, 24, 36, 0.5),
      rgba(16, 24, 36, 0.2)
    );
    max-width: 820px;
  }
  .project-switcher {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
    margin-bottom: 14px;
  }
  .palette {
    display: flex;
    gap: 12px;
    justify-content: center;
  }
  .palette input {
    width: 560px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #1e293b;
    background: #0b1220;
    color: var(--text);
  }
  .plans-dropdown {
    margin-top: 16px;
  }
  .plans-list {
    list-style: none;
    padding: 0;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
  }
  .hero-footer {
    margin-top: 18px;
    color: var(--muted);
    font-size: 12px;
  }
</style>
