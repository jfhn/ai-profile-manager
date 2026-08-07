<script lang="ts">
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import type { TerminalClientMessage, TerminalServerMessage } from '@apm/shared';
  import { terminalSocketUrl } from './api';

  interface Props {
    sessionId: string;
    /** Fired when the daemon reports the PTY has exited. */
    onexit?: (exitCode: number | null) => void;
  }

  let { sessionId, onexit }: Props = $props();

  // xterm parses these itself, so the oklch token can't be used directly;
  // these mirror --card / --primary from app.css.
  const CARD = '#1c1c1c';
  const PRIMARY = '#4a7ef8';

  let host = $state<HTMLDivElement | null>(null);
  let exited = $state<{ code: number | null } | null>(null);
  let connection = $state<'connecting' | 'open' | 'lost'>('connecting');

  $effect(() => {
    const element = host;
    const id = sessionId;
    if (!element) return;

    exited = null;
    connection = 'connecting';

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: {
        background: CARD,
        foreground: '#e6e6e6',
        cursor: PRIMARY,
        cursorAccent: CARD,
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
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);

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
        send({ type: 'resize', cols: term.cols, rows: term.rows });
        term.focus();
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
            term.reset();
            term.write(message.data);
            break;
          case 'data':
            term.write(message.data);
            break;
          case 'exit':
            exited = { code: message.exitCode };
            onexit?.(message.exitCode);
            break;
          case 'error':
            term.write(`\r\n\u001b[31m[apm] ${message.message}\u001b[0m\r\n`);
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

    const dataListener = term.onData((data) => send({ type: 'input', data }));
    const resizeListener = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

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
      term.dispose();
    };
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
    background: rgba(255, 255, 255, 0.03);
  }

  .lost {
    color: color-mix(in oklab, var(--destructive) 82%, white);
    background: color-mix(in oklab, var(--destructive) 10%, transparent);
  }
</style>
