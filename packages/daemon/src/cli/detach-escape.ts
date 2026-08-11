/** Legacy telnet-style detach byte produced by Ctrl-] (and often Ctrl-5). */
const LEGACY_DETACH = 0x1d;
const TILDE = 0x7e;
const DETACH_COMMAND = 0x64; // d
const ESC = 0x1b;
const CR = 0x0d;
const LF = 0x0a;
const BRACKETED_PASTE_START = Buffer.from('\u001b[200~');
const BRACKETED_PASTE_END = Buffer.from('\u001b[201~');

export interface DetachEscapeResult {
  /** Bytes safe to forward to the remote PTY. */
  data: Buffer;
  /** True once the caller should close its terminal WebSocket. */
  detach: boolean;
}

/**
 * Filters the local terminal byte stream for APM's client-side detach escape.
 *
 * `~d` is special only at the start of input or immediately after CR/LF,
 * matching SSH's line-bound escape model. `~~` emits one literal tilde there;
 * every other `~x` pair passes through unchanged. Bracketed paste is tracked
 * across chunks so pasted source code can never accidentally detach a session.
 */
export class DetachEscapeParser {
  private atLineStart = true;
  private tildePending = false;
  private detached = false;
  private inBracketedPaste = false;
  private markerMatch = 0;
  private lineStartBeforeMarker = true;

  write(chunk: Buffer): DetachEscapeResult {
    if (this.detached) return { data: Buffer.alloc(0), detach: true };

    const output: number[] = [];
    const emit = (byte: number): void => {
      output.push(byte);
      this.atLineStart = byte === CR || byte === LF;
    };

    for (const byte of chunk) {
      if (this.inBracketedPaste) {
        const markerComplete = this.advanceMarker(byte, BRACKETED_PASTE_END);
        emit(byte);
        if (markerComplete) {
          this.inBracketedPaste = false;
          this.atLineStart = this.lineStartBeforeMarker;
        }
        continue;
      }

      if (this.tildePending) {
        this.tildePending = false;
        if (byte === DETACH_COMMAND) {
          this.detached = true;
          break;
        }
        if (byte === TILDE) {
          emit(TILDE);
          continue;
        }
        emit(TILDE);
      }

      if (byte === LEGACY_DETACH) {
        this.detached = true;
        break;
      }
      if (this.atLineStart && byte === TILDE) {
        this.tildePending = true;
        continue;
      }

      const markerComplete = this.advanceMarker(byte, BRACKETED_PASTE_START);
      emit(byte);
      if (markerComplete) {
        this.inBracketedPaste = true;
        this.atLineStart = this.lineStartBeforeMarker;
      }
    }

    return { data: Buffer.from(output), detach: this.detached };
  }

  /** Track one invisible bracketed-paste marker without buffering user input. */
  private advanceMarker(byte: number, marker: Buffer): boolean {
    if (this.markerMatch === 0) {
      if (byte !== ESC) return false;
      this.markerMatch = 1;
      this.lineStartBeforeMarker = this.atLineStart;
      return false;
    }

    if (byte === marker[this.markerMatch]) {
      this.markerMatch += 1;
      if (this.markerMatch !== marker.length) return false;
      this.markerMatch = 0;
      return true;
    }

    if (byte === ESC) {
      this.markerMatch = 1;
      this.lineStartBeforeMarker = this.atLineStart;
    } else {
      this.markerMatch = 0;
    }
    return false;
  }
}
