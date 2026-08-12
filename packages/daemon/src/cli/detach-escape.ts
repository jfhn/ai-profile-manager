/** Legacy telnet-style detach byte produced by Ctrl-] (and often Ctrl-5). */
const LEGACY_DETACH = 0x1d;
const TILDE = 0x7e;
const DETACH_COMMAND = 0x64; // d
const ESC = 0x1b;
const CSI = 0x5b;
const CR = 0x0d;
const LF = 0x0a;
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
const MAX_CONTROL_SEQUENCE_BYTES = 64;
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
 * Ctrl-] and Ctrl-5 are accepted both as the legacy 0x1d byte and as the
 * CSI-u sequences emitted while a TUI has enhanced keyboard reporting enabled.
 */
export class DetachEscapeParser {
  private atLineStart = true;
  private tildePending = false;
  private detached = false;
  private inBracketedPaste = false;
  private markerMatch = 0;
  private lineStartBeforeMarker = true;
  private controlSequence: number[] = [];

  /** True while an ESC-prefixed sequence may still become an enhanced detach. */
  get hasPendingControlSequence(): boolean {
    return this.controlSequence.length > 0;
  }

  /** Release an incomplete sequence after the caller's Escape-key timeout. */
  flushPendingControlSequence(): Buffer {
    if (this.controlSequence.length === 0) return Buffer.alloc(0);
    const pending = Buffer.from(this.controlSequence);
    this.controlSequence = [];
    for (const byte of pending) this.trackForwardedByte(byte);
    return pending;
  }

  write(chunk: Buffer): DetachEscapeResult {
    if (this.detached) return { data: Buffer.alloc(0), detach: true };

    const output: number[] = [];
    const emit = (byte: number): void => {
      output.push(byte);
      this.trackForwardedByte(byte);
    };
    const forwardControlSequence = (): void => {
      const startsBracketedPaste = Buffer.from(this.controlSequence).equals(BRACKETED_PASTE_START);
      const lineStartBeforeSequence = this.atLineStart;
      for (const pendingByte of this.controlSequence) emit(pendingByte);
      this.controlSequence = [];
      if (startsBracketedPaste) {
        this.inBracketedPaste = true;
        this.markerMatch = 0;
        this.lineStartBeforeMarker = lineStartBeforeSequence;
        this.atLineStart = lineStartBeforeSequence;
      }
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

      if (this.controlSequence.length > 0) {
        this.controlSequence.push(byte);
        if (this.controlSequence.length === 2 && byte !== CSI) {
          forwardControlSequence();
          continue;
        }

        const complete =
          this.controlSequence.length > 2 && byte >= CSI_FINAL_MIN && byte <= CSI_FINAL_MAX;
        if (complete) {
          if (isEnhancedDetach(Buffer.from(this.controlSequence))) {
            this.controlSequence = [];
            this.detached = true;
            break;
          }
          forwardControlSequence();
          continue;
        }

        if (this.controlSequence.length >= MAX_CONTROL_SEQUENCE_BYTES) {
          forwardControlSequence();
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
      if (byte === ESC) {
        this.controlSequence.push(byte);
        continue;
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

  private trackForwardedByte(byte: number): void {
    this.atLineStart = byte === CR || byte === LF;
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

/** Ctrl-] / Ctrl-5 as Kitty CSI-u or xterm modifyOtherKeys input. */
function isEnhancedDetach(sequence: Buffer): boolean {
  const encoded = sequence.toString('ascii');
  if (!encoded.startsWith('\u001b[')) return false;
  const body = encoded.slice(2);
  const csiU = /^(53|93)(?::[0-9]+)*;([0-9]+)(?::([123]))?u$/.exec(body);
  if (csiU) {
    return csiU[3] !== '3' && isUnmodifiedCtrl(Number(csiU[2]));
  }

  const modifyOtherKeys = /^27;([0-9]+);(53|93)~$/.exec(body);
  return modifyOtherKeys !== null && isUnmodifiedCtrl(Number(modifyOtherKeys[1]));
}

/** Modifier value is one plus a bitset: Shift, Alt, Ctrl, Super, Hyper, Meta, locks. */
function isUnmodifiedCtrl(encodedModifier: number): boolean {
  if (!Number.isSafeInteger(encodedModifier) || encodedModifier < 1) return false;
  const CTRL = 4;
  const CAPS_LOCK = 64;
  const NUM_LOCK = 128;
  const modifiers = encodedModifier - 1;
  return (modifiers & CTRL) !== 0 && (modifiers & ~(CTRL | CAPS_LOCK | NUM_LOCK)) === 0;
}
