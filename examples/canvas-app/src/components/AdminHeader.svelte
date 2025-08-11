<script lang="ts">
  import { createEventDispatcher } from "svelte";
  export let project: string;
  export let projects: string[] = [];
  const dispatch = createEventDispatcher();
  function onChangeProject() {
    dispatch("projectChange", { project });
  }
</script>

<header class="ds-header">
  <h1 class="ds-brand">METIS</h1>
  <div class="controls">
    <select class="ds-select" bind:value={project} on:change={onChangeProject}>
      {#each projects as pr}
        <option value={pr}>{pr}</option>
      {/each}
    </select>
    <button class="ds-btn" on:click={() => dispatch("refreshTools")}
      >Refresh Tools</button
    >
    <button class="ds-btn" on:click={() => dispatch("refreshEvents")}
      >Refresh Events</button
    >
    <span class="ds-spacer"></span>
    <button class="ds-btn ghost" on:click={() => dispatch("goHome")}
      >Home</button
    >
  </div>
</header>

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
</style>
