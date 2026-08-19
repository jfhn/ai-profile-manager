<script lang="ts">
  import type { ProviderId, TerminalSession } from '@apm/shared';
  import { api } from '../api';
  import { app } from '../stores.svelte';
  import { toastError } from '../toasts.svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    onclose: () => void;
    oncreated: (session: TerminalSession) => void;
  }

  let { onclose, oncreated }: Props = $props();

  const FALLBACK_PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'cursor'];
  const FALLBACK_DEFAULT_APPS: Record<ProviderId, string> = {
    claude: 'claude',
    codex: 'codex',
    cursor: 'cursor-agent',
  };

  function defaultAppFor(provider: ProviderId): string {
    return (
      app.providers.find((info) => info.id === provider)?.defaultApp ??
      FALLBACK_DEFAULT_APPS[provider]
    );
  }

  const profiles = $derived(app.launchable);
  const providerIds = $derived(
    app.providers.length > 0 ? app.providers.map((info) => info.id) : FALLBACK_PROVIDER_IDS,
  );
  const grouped = $derived(
    providerIds
      .map((provider) => ({
        provider,
        label: app.providerLabel(provider),
        items: profiles.filter((profile) => profile.provider === provider),
      }))
      .filter((group) => group.items.length > 0),
  );

  const APP_CHOICES = $derived([
    ...(app.providers.length > 0
      ? app.providers.map((info) => info.defaultApp)
      : FALLBACK_PROVIDER_IDS.map((id) => FALLBACK_DEFAULT_APPS[id])),
    'custom',
  ]);

  // The modal only opens once profiles are loaded, so the default is stable.
  const initial = app.launchable[0];

  let profileId = $state(initial?.id ?? '');
  let appChoice = $state(initial ? defaultAppFor(initial.provider) : 'claude');
  let customApp = $state('');
  let cwd = $state('');
  let dirs = $state<string[]>([]);
  let busy = $state(false);

  $effect(() => {
    void api
      .recentDirs()
      .then((response) => {
        dirs = response.dirs;
        if (cwd === '' && response.dirs[0]) cwd = response.dirs[0];
      })
      .catch(() => {
        dirs = [];
      });
  });

  function selectProfile(id: string): void {
    profileId = id;
    const profile = app.profile(id);
    if (profile && appChoice !== 'custom') appChoice = defaultAppFor(profile.provider);
  }

  const resolvedApp = $derived(appChoice === 'custom' ? customApp.trim() : appChoice);
  const canSubmit = $derived(profileId !== '' && resolvedApp.length > 0 && !busy);

  async function create(): Promise<void> {
    if (!canSubmit) return;
    busy = true;
    try {
      const trimmedCwd = cwd.trim();
      const session = await api.createSession({
        profileId,
        app: resolvedApp,
        ...(trimmedCwd ? { cwd: trimmedCwd } : {}),
      });
      oncreated(session);
      onclose();
    } catch (error) {
      toastError(error, 'Could not start the session');
    } finally {
      busy = false;
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    void create();
  }
</script>

<Modal
  title="New session"
  subtitle="The profile's environment is fixed when the process starts."
  width={480}
  {onclose}
>
  {#if profiles.length === 0}
    <p class="empty">
      No active profile is available yet. Add one on the dashboard first — sessions always run with
      a profile's credentials.
    </p>
  {:else}
    <form onsubmit={submit} class="form">
      <div class="field">
        <label class="label" for="session-profile">Profile</label>
        <select
          id="session-profile"
          class="select"
          data-autofocus
          value={profileId}
          onchange={(event) => selectProfile(event.currentTarget.value)}
        >
          {#each grouped as group (group.provider)}
            <optgroup label={group.label}>
              {#each group.items as profile (profile.id)}
                <option value={profile.id}>{profile.label}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </div>

      <div class="field">
        <span class="label">App</span>
        <div class="segmented" role="group" aria-label="App to launch">
          {#each APP_CHOICES as choice (choice)}
            <button
              class="segment"
              class:active={appChoice === choice}
              type="button"
              onclick={() => (appChoice = choice)}
            >
              {choice}
            </button>
          {/each}
        </div>
        {#if appChoice === 'custom'}
          <input
            class="input custom"
            bind:value={customApp}
            placeholder="bash"
            autocomplete="off"
            aria-label="Custom command"
          />
          <p class="hint">
            Runs with the profile's env injected — e.g. a shell where every claude call uses it.
          </p>
        {/if}
      </div>

      <div class="field">
        <label class="label" for="session-cwd">Working directory</label>
        <input
          id="session-cwd"
          class="input"
          bind:value={cwd}
          list="recent-dirs"
          placeholder="~/projects/app"
          autocomplete="off"
          spellcheck="false"
        />
        <datalist id="recent-dirs">
          {#each dirs as dir (dir)}
            <option value={dir}></option>
          {/each}
        </datalist>
      </div>

      <button type="submit" hidden aria-hidden="true"></button>
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button
      variant="primary"
      loading={busy}
      disabled={!canSubmit || profiles.length === 0}
      onclick={() => void create()}
    >
      Start session
    </Button>
  {/snippet}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .empty {
    font-size: 13px;
    color: var(--muted-fg);
  }

  .segmented {
    display: inline-flex;
    align-self: flex-start;
    padding: 2px;
    background: var(--fill-4);
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .segment {
    height: 26px;
    padding: 0 14px;
    font-size: 12px;
    color: var(--muted-fg);
    border-radius: 6px;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .segment:hover {
    color: var(--fg);
  }

  .segment.active {
    background: var(--fill-8);
    color: var(--fg);
  }

  .custom {
    margin-top: 4px;
  }
</style>
