<script lang="ts">
  import type { Profile, ProviderId } from '@apm/shared';
  import { api } from '../api';
  import { app } from '../stores.svelte';
  import { toastError } from '../toasts.svelte';
  import ProviderMark from './ProviderMark.svelte';

  let changing = $state<ProviderId | null>(null);

  function candidates(provider: ProviderId): Profile[] {
    return app.launchable
      .filter((profile) => profile.provider === provider)
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async function change(provider: ProviderId, event: Event): Promise<void> {
    const select = event.currentTarget as HTMLSelectElement;
    const profileId = select.value || null;
    changing = provider;
    try {
      const result = await api.setDefault(provider, { profileId });
      app.defaultProfileIds = result.defaultProfileIds;
    } catch (error) {
      select.value = app.defaultProfileIds[provider] ?? '';
      toastError(error, `Could not update the ${app.providerLabel(provider)} default`);
    } finally {
      changing = null;
    }
  }
</script>

<section class="defaults" aria-labelledby="profile-defaults-heading">
  <div class="copy">
    <h2 id="profile-defaults-heading">New-session defaults</h2>
    <p>Used by integrations when they start new work. Existing sessions keep their profile.</p>
  </div>
  <div class="selectors">
    {#each app.providers as provider (provider.id)}
      <label>
        <span class="provider"><ProviderMark provider={provider.id} />{provider.label}</span>
        <select
          aria-label={`${provider.label} default profile`}
          value={app.defaultProfileIds[provider.id] ?? ''}
          disabled={changing === provider.id}
          onchange={(event) => void change(provider.id, event)}
        >
          <option value="">No default</option>
          {#each candidates(provider.id) as profile (profile.id)}
            <option value={profile.id}>{profile.label}</option>
          {/each}
        </select>
      </label>
    {/each}
  </div>
</section>

<style>
  .defaults {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 20px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
  }

  .copy {
    min-width: 0;
  }

  h2 {
    margin: 0 0 2px;
    font-size: 13px;
    font-weight: 600;
  }

  p {
    margin: 0;
    color: var(--muted-fg);
    font-size: 12px;
  }

  .selectors {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
  }

  label {
    display: grid;
    gap: 4px;
  }

  .provider {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--muted-fg);
    font-size: 11px;
    font-weight: 500;
  }

  select {
    min-width: 150px;
    padding: 6px 28px 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    background: var(--fill-3);
    font: inherit;
    font-size: 12px;
  }

  @media (max-width: 760px) {
    .defaults {
      align-items: stretch;
      flex-direction: column;
    }

    .selectors {
      justify-content: stretch;
    }

    label {
      flex: 1;
    }

    select {
      width: 100%;
    }
  }
</style>
