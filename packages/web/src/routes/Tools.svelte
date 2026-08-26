<script lang="ts">
  import type { CliToolStatus, InstalledCliTool, ProviderId } from '@apm/shared';
  import { api, errorMessage } from '../lib/api';
  import { toast, toastError } from '../lib/toasts.svelte';
  import Badge from '../lib/components/Badge.svelte';
  import Button from '../lib/components/Button.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import PageHeader from '../lib/components/PageHeader.svelte';
  import ProviderMark from '../lib/components/ProviderMark.svelte';

  let tools = $state<CliToolStatus[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let updating = $state<ProviderId | null>(null);

  async function load(): Promise<void> {
    loading = true;
    try {
      tools = await api.tools();
      loadError = null;
    } catch (error) {
      tools = [];
      loadError = errorMessage(error);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  async function update(tool: InstalledCliTool): Promise<void> {
    if (updating !== null) return;
    updating = tool.provider;
    try {
      const result = await api.updateTool(tool.provider);
      tools = tools.map((entry) => (entry.provider === tool.provider ? result.tool : entry));
      const changed = result.previousVersion !== result.tool.version;
      toast(
        changed ? `${tool.label} updated` : `${tool.label} is up to date`,
        changed ? `${result.previousVersion} to ${result.tool.version}.` : result.tool.version,
      );
    } catch (error) {
      toastError(error, `Could not update ${tool.label}`);
    } finally {
      updating = null;
    }
  }
</script>

<div class="page">
  <PageHeader title="CLI tools" subtitle="Installed on this machine and shared by every profile">
    {#snippet actions()}
      <Button variant="ghost" {loading} onclick={() => void load()}>
        {#if !loading}<Icon name="refresh" size={14} />{/if}
        Refresh
      </Button>
    {/snippet}
  </PageHeader>

  {#if loadError}
    <div class="surface notice">
      <Icon name="alert" size={16} />
      <div class="names">
        <span class="name">Cannot read CLI tools</span>
        <span class="muted">{loadError}</span>
      </div>
      <Button size="sm" {loading} onclick={() => void load()}>Try again</Button>
    </div>
  {:else}
    <div class="rows surface">
      {#if loading && tools.length === 0}
        <p class="row muted">Reading installed tools…</p>
      {/if}
      {#each tools as tool (tool.provider)}
        <div class="row">
          <ProviderMark provider={tool.provider} />
          <div class="names">
            <span class="name">{tool.label}</span>
          </div>
          {#if tool.state === 'installed'}
            <span class="path mono muted truncate" title={tool.executable}>{tool.executable}</span>
            <Badge>{tool.version}</Badge>
            <Button
              size="sm"
              loading={updating === tool.provider}
              disabled={updating !== null}
              onclick={() => void update(tool)}>Update</Button
            >
          {:else if tool.state === 'missing'}
            <Badge>not installed</Badge>
          {:else}
            <span class="path mono muted truncate" title={tool.error}>{tool.executable}</span>
            <Badge tone="warning" title={tool.error}>unavailable</Badge>
          {/if}
        </div>
      {/each}
    </div>

    {#if tools.length > 0}
      <p class="foot muted">
        apm calls each tool's built-in updater. It updates the executable shown here and does not
        change profile homes.
      </p>
    {/if}
  {/if}
</div>

<style>
  .page {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
  }

  .page > :global(*) {
    max-width: 1200px;
    margin-inline: auto;
  }

  .rows {
    overflow: hidden;
  }

  .row,
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 12px 14px;
  }

  .row + .row {
    border-top: 1px solid var(--border);
  }

  .names {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    font-size: 13px;
    font-weight: 500;
  }

  .path {
    width: min(38vw, 420px);
    font-size: 11px;
    text-align: right;
  }

  .muted {
    font-size: 11px;
    color: var(--muted-fg);
  }

  .foot {
    margin-top: 12px;
  }

  @media (max-width: 760px) {
    .path {
      display: none;
    }
  }
</style>
