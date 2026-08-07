<script lang="ts">
  interface Props {
    rows?: number;
  }

  let { rows = 2 }: Props = $props();
</script>

<div class="card" aria-hidden="true">
  <div class="head">
    <div class="skeleton chip"></div>
    <div class="skeleton name"></div>
  </div>
  <div class="skeleton line"></div>
  <div class="rows">
    {#each Array.from({ length: rows }, (_, index) => index) as row (row)}
      <div class="row">
        <div class="skeleton label"></div>
        <div class="skeleton bar"></div>
        <div class="skeleton pct"></div>
      </div>
    {/each}
  </div>
  <div class="skeleton foot"></div>
</div>

<style>
  .card {
    padding: 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .chip {
    width: 52px;
    height: 18px;
    border-radius: 999px;
  }

  .name {
    width: 96px;
    height: 13px;
  }

  .line {
    width: 62%;
    height: 11px;
    margin-top: 12px;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 18px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .label {
    width: 24px;
    height: 10px;
  }

  .bar {
    flex: 1;
    height: 6px;
    border-radius: 999px;
  }

  .pct {
    width: 60px;
    height: 10px;
  }

  .foot {
    width: 78%;
    height: 10px;
    margin-top: 22px;
  }
</style>
