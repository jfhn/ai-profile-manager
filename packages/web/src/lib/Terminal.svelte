<script lang="ts">
  import { untrack } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import type { ITheme } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import type { TerminalClientMessage, TerminalServerMessage } from '@apm/shared';
  import { terminalSocketUrl } from './api';
  import { theme as appTheme } from './theme.svelte';
  import type { ColorScheme } from './theme';

  interface Props {
    sessionId: string;
    /** Fired when the daemon reports the PTY has exited. */
    onexit?: (exitCode: number | null) => void;
  }

  let { sessionId, onexit }: Props = $props();

  // xterm parses these itself, so the CSS tokens can't be used directly; the
  // surface colors mirror --card / --primary from app.css per scheme.
  const PRIMARY = '#4a7ef8';

  const TERMINAL_THEMES: Record<ColorScheme, ITheme> = {
    dark: {
      background: '#1c1c1c',
      foreground: '#e6e6e6',
      cursor: PRIMARY,
      cursorAccent: '#1c1c1c',
      selectionBackground: 'rgba(74, 126, 248, 0.3)',
      black: '#2a2a2a',
      red: '#f26d6d',
      green: '#10b981',
      yellow: '#f59e0b',
      blue: '#6c9cf8',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#d4d4d8',
      brightBlack: '#6b6b70',
      brightRed: '#ff8f8f',
      brightGreen: '#34d399',
      brightYellow: '#fbbf24',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#fafafa',
    },
    light: {
      background: '#ffffff',
      foreground: '#27272a',
      cursor: PRIMARY,
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(74, 126, 248, 0.22)',
      black: '#3f3f46',
      red: '#c23b3b',
      green: '#0f8a5f',
      yellow: '#a1670a',
      blue: '#2f5fd0',
      magenta: '#8b3fc7',
      cyan: '#0e7490',
      // The light scheme inverts the neutral ramp: ANSI white has to stay
      // legible on a white background, so it lands in the grays.
      white: '#52525b',
      brightBlack: '#71717a',
      brightRed: '#d94f4f',
      brightGreen: '#12a978',
      brightYellow: '#bd7f14',
      brightMagenta: '#a855f7',
      brightCyan: '#0891b2',
      brightWhite: '#27272a',
    },
  };

  let host = $state<HTMLDivElement | null>(null);
  let term = $state<Terminal | null>(null);
  let exited = $state<{ code: number | null } | null>(null);
  let connection = $state<'connecting' | 'open' | 'lost'>('connecting');

  $effect(() => {
    const element = host;
    const id = sessionId;
    if (!element) return;

    exited = null;
    connection = 'connecting';

    const instance = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      macOptionIsMeta: true,
      // Untracked: a theme switch restyles the live terminal (effect below)
      // instead of tearing the session down and reconnecting.
      theme: TERMINAL_THEMES[untrack(() => appTheme.scheme)],
    });
    term = instance;

    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(element);

    let socket: WebSocket | null = null;
    let disposed = false;
    let retried = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (message: TerminalClientMessage): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const safeFit = (): void => {
      if (disposed || element.clientWidth === 0 || element.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // fit throws while the pane is being torn down; nothing to do.
      }
    };

    const connect = (): void => {
      if (disposed) return;
      const ws = new WebSocket(terminalSocketUrl(id));
      socket = ws;

      ws.onopen = () => {
        connection = 'open';
        safeFit();
        send({ type: 'resize', cols: instance.cols, rows: instance.rows });
        instance.focus();
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        let message: TerminalServerMessage;
        try {
          message = JSON.parse(event.data) as TerminalServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case 'scrollback':
            instance.reset();
            instance.write(message.data);
            break;
          case 'data':
            instance.write(message.data);
            break;
          case 'exit':
            exited = { code: message.exitCode };
            onexit?.(message.exitCode);
            break;
          case 'error':
            instance.write(`\r\n\u001b[31m[apm] ${message.message}\u001b[0m\r\n`);
            break;
        }
      };

      ws.onclose = () => {
        if (disposed || exited) return;
        // One quiet retry covers a daemon reload or a dropped proxy connection.
        if (!retried) {
          retried = true;
          connection = 'connecting';
          retryTimer = setTimeout(connect, 600);
        } else {
          connection = 'lost';
        }
      };

      ws.onerror = () => {
        if (!disposed && !exited && retried) connection = 'lost';
      };
    };

    const dataListener = instance.onData((data) => send({ type: 'input', data }));
    const resizeListener = instance.onResize(({ cols, rows }) =>
      send({ type: 'resize', cols, rows }),
    );

    const observer = new ResizeObserver(() => safeFit());
    observer.observe(element);

    safeFit();
    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      observer.disconnect();
      dataListener.dispose();
      resizeListener.dispose();
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      instance.dispose();
      if (term === instance) term = null;
    };
  });

  // Follow the app color scheme without recreating the session.
  $effect(() => {
    const instance = term;
    const scheme = appTheme.scheme;
    if (instance) instance.options.theme = TERMINAL_THEMES[scheme];
  });
</script>

<div class="wrap">
  <div class="term" bind:this={host}></div>

  {#if exited}
    <div class="bar exited">
      exited{exited.code === null ? '' : ` (code ${exited.code})`}
    </div>
  {:else if connection === 'lost'}
    <div class="bar lost">connection lost — reopen this session to reattach</div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .term {
    flex: 1;
    min-height: 0;
    padding: 10px 12px;
  }

  .term :global(.xterm) {
    height: 100%;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    font-size: 12px;
    border-top: 1px solid var(--border);
  }

  .exited {
    color: var(--muted-fg);
    background: var(--fill-3);
  }

  .lost {
    color: color-mix(in oklab, var(--destructive) 82%, var(--tint-contrast));
    background: color-mix(in oklab, var(--destructive) 10%, transparent);
  }
</style>
