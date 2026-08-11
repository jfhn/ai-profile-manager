import { describe, expect, it } from 'vitest';
import { DetachEscapeParser } from './detach-escape.js';

describe('DetachEscapeParser', () => {
  it('detaches on ~d at the start of input or immediately after Enter', () => {
    const initial = parse(['~', 'dignored']);
    expect(initial.data).toBe('');
    expect(initial.detached).toBe(true);

    const afterEnter = parse(['hello\r', '~', 'dignored']);
    expect(afterEnter.data).toBe('hello\r');
    expect(afterEnter.detached).toBe(true);
  });

  it('keeps the legacy Ctrl-] detach byte working', () => {
    const result = parse(['hello', Buffer.from([0x1d]), 'ignored']);

    expect(result.data).toBe('hello');
    expect(result.detached).toBe(true);
  });

  it('passes ~d through when it is not at the beginning of a line', () => {
    const result = parse(['echo ~done\rnext~d']);

    expect(result.data).toBe('echo ~done\rnext~d');
    expect(result.detached).toBe(false);
  });

  it('uses ~~ to send one literal tilde at the beginning of a line', () => {
    const result = parse(['\r~', '~d\n', '~', '~']);

    expect(result.data).toBe('\r~d\n~');
    expect(result.detached).toBe(false);
  });

  it('passes unsupported escape commands through unchanged', () => {
    const result = parse(['\r~', 'x\r~', '\r']);

    expect(result.data).toBe('\r~x\r~\r');
    expect(result.detached).toBe(false);
  });

  it('never interprets detach escapes inside bracketed paste', () => {
    const pasted = '\u001b[200~first\r~d\n\u001d\r~~last\u001b[201~';
    const result = parse([
      pasted.slice(0, 2),
      pasted.slice(2, 7),
      pasted.slice(7, -3),
      pasted.slice(-3),
      '\r~dignored',
    ]);

    expect(result.data).toBe(`${pasted}\r`);
    expect(result.detached).toBe(true);
  });

  it('preserves UTF-8 bytes split across input chunks', () => {
    const bytes = Buffer.from('日本語\r~~', 'utf8');
    const parser = new DetachEscapeParser();
    const outputs: Buffer[] = [];

    for (const byte of bytes) {
      outputs.push(parser.write(Buffer.from([byte])).data);
    }

    expect(Buffer.concat(outputs).toString('utf8')).toBe('日本語\r~');
  });
});

function parse(chunks: Array<string | Buffer>): { data: string; detached: boolean } {
  const parser = new DetachEscapeParser();
  const outputs: Buffer[] = [];
  let detached = false;
  for (const chunk of chunks) {
    const result = parser.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    outputs.push(result.data);
    detached ||= result.detach;
  }
  return { data: Buffer.concat(outputs).toString(), detached };
}
