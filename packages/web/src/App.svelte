<script lang="ts">
  import { token } from './lib/api';
  import { app, boot } from './lib/stores.svelte';
  import { router } from './lib/router.svelte';
  import Button from './lib/components/Button.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import ToastHost from './lib/components/ToastHost.svelte';
  import Dashboard from './routes/Dashboard.svelte';
  import Sessions from './routes/Sessions.svelte';
  import T3Instances from './routes/T3Instances.svelte';

  if (token) void boot();

  function retry(): void {
    window.location.reload();
  }
</script>

{#if !token}
  <div class="gate">
    <div class="notice surface">
      <span class="mark" aria-hidden="true"></span>
      <h1 class="section-title">This dashboard requires the launch token</h1>
      <p class="body">
        apm mints a fresh token every time the daemon starts and never stores it in the browser
        beyond this tab. Start it with <code class="mono">apm</code> from a terminal — the command opens
        this page with a valid token.
      </p>
    </div>
  </div>
{:else if app.bootError}
  <div class="gate">
    <div class="notice surface">
      <span class="mark error" aria-hidden="true"></span>
      <h1 class="section-title">Cannot reach the daemon</h1>
      <p class="body">{app.bootError}</p>
      <div class="gate-action">
        <Button variant="primary" onclick={retry}>Try again</Button>
      </div>
    </div>
  </div>
{:else}
  <div class="shell">
    <Sidebar />
    <main>
      {#if router.path === '/sessions'}
        <Sessions />
      {:else if router.path === '/t3'}
        <T3Instances />
      {:else}
        <Dashboard />
      {/if}
    </main>
  </div>
{/if}

<ToastHost />

<style>
  .shell {
    display: flex;
    height: 100%;
  }

  main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .gate {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
  }

  .notice {
    width: 440px;
    max-width: 100%;
    padding: 24px;
    text-align: center;
  }

  .mark {
    display: inline-block;
    width: 28px;
    height: 28px;
    margin-bottom: 14px;
    border-radius: 9px;
    background: var(--mark-gradient);
  }

  .mark.error {
    background: var(--mark-gradient-error);
  }

  .body {
    margin-top: 8px;
    font-size: 13px;
    color: var(--muted-fg);
  }

  .body code {
    padding: 1px 5px;
    color: var(--fg);
    background: var(--fill-7);
    border-radius: 4px;
  }

  .gate-action {
    display: flex;
    justify-content: center;
    margin-top: 16px;
  }
</style>
