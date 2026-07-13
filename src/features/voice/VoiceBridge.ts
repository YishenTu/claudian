// TypeScript port of code-tui's Go `voice/bridge.go`, layered on AcpSubprocess.
//
// The bridge speaks an async command/event line protocol with the voicecode
// Python sidecar (voice_bridge.py) so an interrupt can land mid-playback
// (barge-in): commands are JSON lines written to stdin, and every stdout line is
// parsed into a typed event delivered to registered listeners. There is NO
// Claude agent inside the Python process — the host owns the agent; the bridge
// only does STT capture and TTS playback.
//
// Protocol (one JSON object per line):
//   Commands (host → bridge): {"cmd":"listen"} | {"cmd":"speak","text":"…"} |
//                             {"cmd":"interrupt"} | {"cmd":"status"} |
//                             {"cmd":"shutdown"}
//   Events   (bridge → host): {"type":"ready"} | {"type":"initialized"} |
//                             {"type":"transcript","text":"…"} |
//                             {"type":"speak-done"} | {"type":"interrupted"} |
//                             {"type":"error","message":"…"} |
//                             {"type":"status","status":"…","stt":"…","tts":"…"}

import type { Readable } from 'node:stream';

import { AcpSubprocess } from '../../providers/acp/AcpSubprocess';

/** startupTimeout bounds the wait for the ready/initialized handshake. Model
 *  loading on the Python side can take several seconds. */
const STARTUP_TIMEOUT_MS = 60_000;

/** A command from the host to the Python bridge. */
export interface VoiceCommand {
  /** listen | speak | interrupt | status | shutdown */
  cmd: 'listen' | 'speak' | 'interrupt' | 'status' | 'shutdown';
  /** Text to synthesize (speak only). */
  text?: string;
}

/** An event from the Python bridge to the host. */
export interface VoiceEvent {
  /** ready | initialized | transcript | speak-done | interrupted | error | status */
  type: string;
  /** Recognized utterance (transcript). */
  text?: string;
  /** Failure detail (error). */
  message?: string;
  /** Bridge status (status). */
  status?: string;
  /** Active STT backend (status). */
  stt?: string;
  /** Active TTS backend (status). */
  tts?: string;
}

/**
 * Parse one stdout line into a VoiceEvent.
 *
 * A blank line yields null (skip it). A malformed line becomes an `error` event
 * rather than tearing the bridge down, so stray non-protocol output on stdout
 * cannot crash the reader. Exported so the pure parse logic can be unit-tested
 * directly (mirrors bridge.go's `parseEvent`).
 */
export function parseVoiceEvent(line: string): VoiceEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as VoiceEvent).type !== 'string') {
      return { type: 'error', message: `malformed event: ${trimmed}` };
    }
    return parsed as VoiceEvent;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { type: 'error', message: `unmarshal event: ${detail}` };
  }
}

type VoiceEventListener = (event: VoiceEvent) => void;

export interface VoiceBridgeOptions {
  /** Override the handshake timeout (ms). Defaults to 60s. */
  startupTimeoutMs?: number;
}

/**
 * Manages the voicecode Python subprocess as an async event pipeline.
 *
 * Structure ports bridge.go: `start()` spawns the process and completes the
 * `ready` → `initialized` handshake before resolving; command methods are
 * fire-and-forget JSON-line writes; events are pushed to listeners as they
 * arrive off stdout.
 */
export class VoiceBridge {
  private readonly proc: AcpSubprocess;
  private readonly startupTimeoutMs: number;
  private readonly listeners = new Set<VoiceEventListener>();

  private started = false;
  private closed = false;
  /** Partial stdout line carried between `data` events until a newline lands. */
  private stdoutBuffer = '';

  constructor(
    pythonPath: string,
    bridgeScriptPath: string,
    cwd: string,
    opts?: VoiceBridgeOptions,
  ) {
    this.startupTimeoutMs = opts?.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.proc = new AcpSubprocess({
      command: pythonPath,
      args: [bridgeScriptPath],
      cwd,
      env: process.env,
    });
  }

  /**
   * Spawn the subprocess, wire the stdout line reader, and await the
   * `ready` → `initialized` handshake. Rejects on timeout, on an early close, or
   * if the bridge reports an `error` during startup.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    this.proc.start();
    this.wireStdout(this.proc.stdout);

    // One waiter for both handshake events: subscribing sequentially would drop
    // an `initialized` that arrives in the same stdout chunk as `ready` (events
    // dispatch synchronously) and hang startup until the timeout.
    await this.awaitStartupEvents(['ready', 'initialized']);
  }

  /** Subscribe to bridge events. Returns an unsubscribe function. */
  onEvent(listener: VoiceEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Arm the mic for one capture. A `transcript` event follows. */
  listen(): void {
    this.send({ cmd: 'listen' });
  }

  /** Queue text for synthesis/playback. A `speak-done` (or `interrupted`) follows. */
  speak(text: string): void {
    this.send({ cmd: 'speak', text });
  }

  /** Cut any in-flight playback now. An `interrupted` event follows. */
  interrupt(): void {
    this.send({ cmd: 'interrupt' });
  }

  /** Request a status snapshot. A `status` event follows. */
  status(): void {
    this.send({ cmd: 'status' });
  }

  /**
   * Gracefully shut the bridge down: send `shutdown` so the Python side exits
   * cleanly, then SIGTERM→SIGKILL the process via AcpSubprocess. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Best-effort graceful shutdown request before we tear the process down.
    try {
      this.writeCommand({ cmd: 'shutdown' });
    } catch {
      // Process may already be gone; the shutdown() below still reaps it.
    }
    this.listeners.clear();
    await this.proc.shutdown();
  }

  /** True while the subprocess is alive and not yet closed. */
  isAlive(): boolean {
    return this.started && !this.closed && this.proc.isAlive();
  }

  /** Trailing stderr from the subprocess (surface in error notices). */
  getStderrSnapshot(): string {
    return this.proc.getStderrSnapshot();
  }

  /** Register a close listener (e.g. the process died unexpectedly). */
  onClose(listener: (error?: Error) => void): () => void {
    return this.proc.onClose(listener);
  }

  // ---- internals ----

  /** Block until all named handshake events arrive, or reject on timeout/close. */
  private awaitStartupEvents(wanted: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const remaining = new Set(wanted);
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribeEvent();
        unsubscribeClose();
        window.clearTimeout(timer);
        fn();
      };
      const missing = (): string => [...remaining].join(', ');

      const unsubscribeEvent = this.onEvent((event) => {
        if (event.type === 'error') {
          finish(() => reject(new Error(`bridge startup error: ${event.message ?? 'unknown'}`)));
          return;
        }
        // Unrelated startup chatter is ignored; keep waiting for the rest.
        remaining.delete(event.type);
        if (remaining.size === 0) {
          finish(resolve);
        }
      });

      const unsubscribeClose = this.proc.onClose((error) => {
        const detail = error?.message ?? this.proc.getStderrSnapshot();
        finish(() =>
          reject(new Error(`bridge closed during startup (expected ${missing()})${detail ? `: ${detail}` : ''}`)),
        );
      });

      const timer = window.setTimeout(() => {
        finish(() => reject(new Error(`timeout waiting for ${missing()} event`)));
      }, this.startupTimeoutMs);
    });
  }

  /** Buffer partial stdout lines and dispatch a VoiceEvent for each full line. */
  private wireStdout(stdout: Readable): void {
    stdout.setEncoding('utf-8');
    stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      let newlineIdx = this.stdoutBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIdx);
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
        const event = parseVoiceEvent(line);
        if (event) {
          this.dispatch(event);
        }
        newlineIdx = this.stdoutBuffer.indexOf('\n');
      }
    });
  }

  /** Notify all listeners. A throwing listener never breaks the reader. */
  private dispatch(event: VoiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are isolated; the protocol stream keeps flowing.
      }
    }
  }

  /** Guard writes after close, then serialize one command line to stdin. */
  private send(command: VoiceCommand): void {
    if (this.closed || !this.started) {
      return; // dropped: nothing to write to
    }
    try {
      this.writeCommand(command);
    } catch {
      // stdin closed or process gone; the onClose path handles teardown.
    }
  }

  private writeCommand(command: VoiceCommand): void {
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }
}
