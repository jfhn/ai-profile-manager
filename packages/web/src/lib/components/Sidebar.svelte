<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './Icon.svelte';
  import StatusDot from './StatusDot.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { router } from '../router.svelte';
  import type { RoutePath } from '../router.svelte';
  import { app } from '../stores.svelte';

  interface NavItem {
    path: RoutePath;
    label: string;
    icon: IconName;
  }

  const items: NavItem[] = [
    { path: '/', label: 'Dashboard', icon: 'dashboard' },
    { path: '/sessions', label: 'Sessions', icon: 'terminal' },
    { path: '/tools', label: 'Tools', icon: 'layers' },
    { path: '/targets', label: 'Targets', icon: 'monitor' },
  ];

  const connectionTone = $derived(
    app.connection === 'live'
      ? 'success'
      : app.connection === 'connecting'
        ? 'warning'
        : 'destructive',
  );

  const connectionLabel = $derived(
    app.connection === 'live'
      ? 'connected to the daemon event stream'
      : app.connection === 'connecting'
        ? 'connecting to the daemon event stream'
        : 'reconnecting to the daemon event stream',
  );
</script>

<aside>
  <a class="brand" href="#/">
    <span class="mark" aria-hidden="true"></span>
    <span class="wordmark">apm</span>
  </a>

  <nav aria-label="Primary">
    {#each items as item (item.path)}
      <a
        class="nav-item"
        class:active={router.path === item.path}
        href={`#${item.path}`}
        aria-current={router.path === item.path ? 'page' : undefined}
      >
        <Icon name={item.icon} size={16} />
        <span>{item.label}</span>
        {#if item.path === '/sessions' && app.sessions.some((session) => session.status === 'running')}
          <span class="count"
            >{app.sessions.filter((session) => session.status === 'running').length}</span
          >
        {/if}
      </a>
    {/each}
  </nav>

  <div class="spacer"></div>

  <div class="footer">
    <ThemeToggle />
    <div class="pill" title={connectionLabel}>
      <StatusDot tone={connectionTone} pulse={app.connection !== 'live'} size={6} />
      <span class="truncate">
        daemon{app.status ? ` · v${app.status.version}` : ''}
      </span>
    </div>
  </div>
</aside>

<style>
  aside {
    display: flex;
    flex-direction: column;
    width: 240px;
    flex: none;
    height: 100%;
    padding: 16px 12px 12px;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--border);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 4px 8px 16px;
  }

  .mark {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--mark-gradient);
    box-shadow: 0 0 0 1px var(--mark-inset) inset;
  }

  .wordmark {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 32px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--muted-fg);
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .nav-item:hover {
    background: var(--hover);
    color: var(--fg);
  }

  .nav-item.active {
    background: var(--hover);
    color: var(--fg);
  }

  .count {
    margin-left: auto;
    min-width: 18px;
    padding: 0 5px;
    text-align: center;
    font-size: 11px;
    line-height: 16px;
    color: var(--muted-fg);
    background: var(--fill-7);
    border-radius: 999px;
  }

  .footer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .pill {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 9px;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted-fg);
  }
</style>
