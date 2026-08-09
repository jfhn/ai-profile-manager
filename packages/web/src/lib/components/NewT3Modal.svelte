<script lang="ts">
  import type { CreateT3InstanceRequest, ProviderId, TargetProfileSummary } from '@apm/shared';
  import { api, errorMessage } from '../api';
  import { navigate } from '../router.svelte';
  import { app, LOCAL_TARGET_ID } from '../stores.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const PROVIDERS: ProviderId[] = ['claude', 'codex'];

  let label = $state('');
  let selection = $state<Record<string, string>>({ claude: '', codex: '' });
  let targetId = $state(LOCAL_TARGET_ID);
  let busy = $state(false);

  /** The local target is always offered, even before /api/targets answered. */
  const targetChoices = $derived([
    { id: LOCAL_TARGET_ID, label: `${app.targetLabel(LOCAL_TARGET_ID)} · this machine` },
    ...app.t3Targets
      .filter((target) => target.id !== LOCAL_TARGET_ID)
      .map((target) => ({ id: target.id, label: target.label })),
  ]);

  const remote = $derived(targetId !== LOCAL_TARGET_ID);

  // Profile ids are target-scoped, so a remote instance picks from the list the
  // target itself reports rather than from this machine's profiles.
  let remoteProfiles = $state<TargetProfileSummary[]>([]);
  let remoteProfileId = $state('');
  let remoteError = $state<string | null>(null);
  let remoteLoading = $state(false);

  $effect(() => {
    const id = targetId;
    remoteProfileId = '';
    remoteError = null;
    if (id === LOCAL_TARGET_ID) {
      remoteProfiles = [];
      return;
    }
    let cancelled = false;
    remoteLoading = true;
    void api
      .targetProfiles(id)
      .then((profiles) => {
        if (cancelled) return;
        remoteProfiles = profiles.filter(
          (profile) => profile.enabled && profile.status === 'active',
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        remoteProfiles = [];
        remoteError = errorMessage(error);
      })
      .finally(() => {
        if (!cancelled) remoteLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  const optionsFor = (provider: ProviderId) =>
    app.launchable.filter((profile) => profile.provider === provider);

  const chosen = $derived(
    remote
      ? remoteProfileId !== ''
      : PROVIDERS.filter((provider) => (selection[provider] ?? '') !== '').length > 0,
  );

  const canSubmit = $derived(label.trim().length > 0 && chosen && !busy);

  function requestBody(): CreateT3InstanceRequest | null {
    if (remote) {
      const profile = remoteProfiles.find((candidate) => candidate.id === remoteProfileId);
      if (!profile) return null;
      return { label: label.trim(), targetId, profiles: { [profile.provider]: profile.id } };
    }
    const profiles: Partial<Record<ProviderId, string>> = {};
    for (const provider of PROVIDERS) {
      const id = selection[provider];
      if (id) profiles[provider] = id;
    }
    // No targetId at all for the local target, so the request is what it was.
    return { label: label.trim(), profiles };
  }

  async function create(): Promise<void> {
    if (!canSubmit) return;
    const body = requestBody();
    if (!body) return;
    busy = true;
    try {
      const instance = await api.createT3(body);
      if (instance && typeof instance.id === 'string') {
        app.t3Instances = [...app.t3Instances, instance];
      }
      toast('Instance created', 'Start it when you need it — each one is a full T3 server.');
      onclose();
    } catch (error) {
      toastError(error, 'Could not create the instance');
    } finally {
      busy = false;
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    void create();
  }

  /** The picker only offers approved machines, so adding one is its own page. */
  function manageTargets(): void {
    onclose();
    navigate('/targets');
  }
</script>

<Modal
  title="New T3 instance"
  subtitle="One T3 server, bound to one profile per provider at launch."
  width={480}
  {onclose}
>
  <form onsubmit={submit} class="form">
    <div class="field">
      <label class="label" for="t3-label">Label</label>
      <input
        id="t3-label"
        class="input"
        bind:value={label}
        data-autofocus
        maxlength="64"
        autocomplete="off"
        placeholder="work"
      />
    </div>

    <div class="field">
      <label class="label" for="t3-target">Target</label>
      <select id="t3-target" class="select" bind:value={targetId}>
        {#each targetChoices as choice (choice.id)}
          <option value={choice.id}>{choice.label}</option>
        {/each}
      </select>
      <p class="hint">
        Only machines you approved appear here.
        <button type="button" class="link" onclick={manageTargets}>Add a target…</button>
      </p>
    </div>

    {#if remote}
      <div class="field">
        <label class="label" for="t3-remote-profile">Profile on {app.targetLabel(targetId)}</label>
        <select
          id="t3-remote-profile"
          class="select"
          disabled={remoteProfiles.length === 0}
          bind:value={remoteProfileId}
        >
          <option value="">
            {remoteLoading
              ? 'loading…'
              : remoteProfiles.length === 0
                ? 'no active profile'
                : 'none'}
          </option>
          {#each remoteProfiles as profile (profile.id)}
            <option value={profile.id}>
              {app.providerLabel(profile.provider)} · {profile.label}
            </option>
          {/each}
        </select>
      </div>

      {#if remoteError}
        <p class="error">{remoteError}</p>
      {/if}

      <p class="hint">
        The instance runs on {app.targetLabel(targetId)} with that profile's environment; its credentials
        stay there. One profile per remote instance, and the Open link is the endpoint the target publishes
        — never a localhost address.
      </p>
    {:else if app.launchable.length === 0}
      <p class="empty">
        No active profile is available yet. Add a profile on the dashboard first — an instance
        always launches with a profile's environment.
      </p>
    {:else}
      {#each PROVIDERS as provider (provider)}
        {@const options = optionsFor(provider)}
        <div class="field">
          <label class="label" for={`t3-${provider}`}>{app.providerLabel(provider)} profile</label>
          <select
            id={`t3-${provider}`}
            class="select"
            disabled={options.length === 0}
            bind:value={selection[provider]}
          >
            <option value="">{options.length === 0 ? 'no active profile' : 'none'}</option>
            {#each options as profile (profile.id)}
              <option value={profile.id}>{profile.label}</option>
            {/each}
          </select>
        </div>
      {/each}

      <p class="hint">
        At least one profile is required. Providers left on "none" fall back to the machine's
        default home.
      </p>
    {/if}
    <button type="submit" hidden aria-hidden="true"></button>
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!canSubmit} onclick={() => void create()}>
      Create
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

  .error {
    font-size: 12px;
    color: color-mix(in oklab, var(--destructive) 82%, var(--tint-contrast));
  }

  .link {
    font: inherit;
    color: var(--fg);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .link:hover {
    color: var(--primary);
  }
</style>
