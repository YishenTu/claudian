// Shared, reference-counted VoiceBridge with an idle linger.
//
// Both dictation and full conversation drive ONE bridge process (one mic). This
// manager hands out a live bridge via acquire(), and releases it via the token
// returned. When the last holder releases, a linger timer starts; if nothing
// re-acquires within the window, the bridge is closed and the mic freed. A fresh
// acquire during linger cancels the timer and reuses the warm bridge, so rapid
// repeat dictation never pays the cold model-load cost twice.

import { Notice } from 'obsidian';

import { VoiceBridge } from './VoiceBridge';
import type { VoiceRuntimeConfig } from './VoiceController';

/** Idle window before an unused bridge is closed and the mic released. */
export const BRIDGE_LINGER_MS = 30_000;

/** A handle held by an acquirer; call release() exactly once when done. */
export interface BridgeLease {
  bridge: VoiceBridge;
  release: () => void;
}

// window.setTimeout in the Obsidian renderer returns a numeric handle.
type TimerHandle = number;

/**
 * Owns the resident bridge and its refcount. Not concerned with turn logic —
 * callers (VoiceController, DictationController) subscribe to the returned
 * bridge's events themselves.
 */
export class ResidentBridge {
  private readonly resolveConfig: () => VoiceRuntimeConfig | null;
  private readonly lingerMs: number;

  private bridge: VoiceBridge | null = null;
  private refcount = 0;
  private lingerTimer: TimerHandle | null = null;
  // In-flight cold-start promise, so concurrent acquires share one handshake.
  private starting: Promise<VoiceBridge> | null = null;

  constructor(
    resolveConfig: () => VoiceRuntimeConfig | null,
    lingerMs: number = BRIDGE_LINGER_MS,
  ) {
    this.resolveConfig = resolveConfig;
    this.lingerMs = lingerMs;
  }

  /** True while a bridge process is resident (warm or in use). */
  isResident(): boolean {
    return this.bridge !== null;
  }

  /** Current number of outstanding leases (exposed for tests/debug). */
  getRefcount(): number {
    return this.refcount;
  }

  /**
   * Acquire the shared bridge, cold-starting it if needed. Increments the
   * refcount and cancels any pending linger. Rejects (after surfacing a Notice)
   * if config is missing or the bridge fails to start.
   */
  async acquire(): Promise<BridgeLease> {
    this.cancelLinger();
    this.refcount += 1;

    try {
      const bridge = await this.ensureBridge();
      return { bridge, release: () => this.release() };
    } catch (error) {
      // Roll back the refcount we optimistically took so linger accounting stays
      // correct, then re-throw for the caller to handle.
      this.refcount = Math.max(0, this.refcount - 1);
      throw error;
    }
  }

  /** Close the bridge immediately, ignoring refcount (used on plugin unload). */
  async shutdown(): Promise<void> {
    this.cancelLinger();
    this.refcount = 0;
    this.starting = null;
    const bridge = this.bridge;
    this.bridge = null;
    if (bridge) {
      await bridge.close();
    }
  }

  // ---- internals ----

  private async ensureBridge(): Promise<VoiceBridge> {
    if (this.bridge) {
      return this.bridge;
    }
    if (this.starting) {
      return this.starting;
    }

    const config = this.resolveConfig();
    if (!config) {
      // resolveConfig surfaced the reason via Notice.
      throw new Error('voice bridge is not configured');
    }

    new Notice('Starting voice…');
    const startup = (async () => {
      const bridge = new VoiceBridge(config.pythonPath, config.bridgeScriptPath, config.cwd);
      await bridge.start();
      this.bridge = bridge;
      return bridge;
    })();
    this.starting = startup;

    try {
      return await startup;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`Voice: failed to start bridge — ${detail}`);
      throw error;
    } finally {
      this.starting = null;
    }
  }

  private release(): void {
    if (this.refcount === 0) {
      return;
    }
    this.refcount -= 1;
    if (this.refcount === 0) {
      this.startLinger();
    }
  }

  private startLinger(): void {
    this.cancelLinger();
    this.lingerTimer = window.setTimeout(() => {
      this.lingerTimer = null;
      // Guard against a re-acquire that landed after the timer fired.
      if (this.refcount === 0) {
        void this.shutdown();
      }
    }, this.lingerMs);
  }

  private cancelLinger(): void {
    if (this.lingerTimer !== null) {
      window.clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }
}
