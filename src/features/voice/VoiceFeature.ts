// Lifecycle facade the plugin uses to drive voice: full conversation mode AND
// one-shot dictation. Both share a single reference-counted bridge (one mic) via
// ResidentBridge, so repeat dictation stays warm without holding the mic when
// idle.
//
// Owns the stream bus (so the StreamController can forward chunks without
// knowing about voice internals) and exposes it on the plugin as `voiceBus`, so
// the single guarded tap in StreamController is a cheap no-op until voice runs.

import { dirname } from 'node:path';

import { Notice } from 'obsidian';

import type { StreamChunk } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { DictationController, type DictationState } from './DictationController';
import { ResidentBridge } from './ResidentBridge';
import { StateStream } from './StateStream';
import { VoiceController, type VoiceRuntimeConfig, type VoiceState, type VoiceStreamBus } from './VoiceController';

/**
 * A tiny synchronous fan-out bus for stream chunks. Each tab's StreamController
 * calls `emit` for every chunk it handles, tagged with its own tab id; the
 * VoiceController subscribes while voice is running and filters to the tab it
 * submitted to. When there are no subscribers, `emit` is a no-op.
 */
export class VoiceStreamBusImpl implements VoiceStreamBus {
  private readonly listeners = new Set<(chunk: StreamChunk, tabId: string) => void>();

  emit(chunk: StreamChunk, tabId: string): void {
    if (this.listeners.size === 0) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(chunk, tabId);
      } catch {
        // A voice-side error must never disrupt chat rendering.
      }
    }
  }

  subscribe(listener: (chunk: StreamChunk, tabId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export class VoiceFeature {
  private readonly plugin: ClaudianPlugin;
  private readonly bus: VoiceStreamBusImpl;
  private readonly residentBridge: ResidentBridge;
  private readonly dictation: DictationController;

  private controller: VoiceController | null = null;
  private starting = false;

  // Controller state mirrored into feature-lifetime streams, so per-tab controls
  // (which outlive any single controller instance) can subscribe once and stay
  // in sync. The current value replays to new subscribers, so a freshly-built
  // tab reflects an already-running session.
  private readonly conversationState$ = new StateStream<VoiceState>('idle');
  private readonly pendingCommand$ = new StateStream<string | null>(null);
  private readonly muted$ = new StateStream(false);
  private controllerUnsubs: Array<() => void> = [];

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
    this.bus = new VoiceStreamBusImpl();
    // Expose the bus so StreamController's guarded tap can reach it.
    this.plugin.voiceBus = this.bus;

    this.residentBridge = new ResidentBridge(() => this.resolveConfig());
    this.dictation = new DictationController(plugin, () => this.residentBridge.acquire());
  }

  /** True while a full conversation session is running. */
  isRunning(): boolean {
    return this.controller !== null;
  }

  /** True while a one-shot dictation capture is in flight. */
  isDictating(): boolean {
    return this.dictation.isListening();
  }

  // ---- full conversation mode ----

  /** Toggle full conversation voice mode on/off. */
  async toggleConversation(): Promise<void> {
    if (this.isRunning()) {
      await this.disable();
    } else {
      await this.enable();
    }
  }

  /** Start a conversation session using the current settings. */
  async enable(): Promise<void> {
    if (this.controller || this.starting) {
      return;
    }
    if (!this.hasBridgeConfig()) {
      this.noticeMissingConfig();
      return;
    }

    this.starting = true;
    const controller = new VoiceController(this.plugin, this.bus, () => this.residentBridge.acquire());
    try {
      // Mirror controller state into the feature-lifetime streams so per-tab
      // controls (waveform, badges, mute button) animate live.
      this.controllerUnsubs = [
        controller.onStateChange((state) => this.conversationState$.set(state)),
        controller.onPendingCommandChange((command) => this.pendingCommand$.set(command)),
        controller.onMuteChange((muted) => this.muted$.set(muted)),
      ];
      await controller.start();
      this.controller = controller;
      new Notice('Voice mode on — listening.');
    } catch {
      // VoiceController.start() surfaced the failure via Notice (or the bridge
      // did); just stay disabled and drop the state subscriptions.
      this.detachControllerSubscriptions();
      this.controller = null;
      this.resetStreams();
    } finally {
      this.starting = false;
    }
  }

  /** Stop the running conversation session, if any. */
  async disable(): Promise<void> {
    const controller = this.controller;
    this.controller = null;
    this.detachControllerSubscriptions();
    if (controller) {
      await controller.stop();
      new Notice('Voice mode off.');
    }
    this.resetStreams();
  }

  /** Drop all live controller subscriptions (state, pending, mute). */
  private detachControllerSubscriptions(): void {
    for (const unsubscribe of this.controllerUnsubs) {
      unsubscribe();
    }
    this.controllerUnsubs = [];
  }

  private resetStreams(): void {
    this.conversationState$.set('idle');
    this.pendingCommand$.set(null);
    this.muted$.set(false);
  }

  /**
   * Subscribe to conversation turn-state. Fires immediately with the current
   * state, then on every change. Used by per-tab waveform indicators.
   */
  onConversationStateChange(listener: (state: VoiceState) => void): () => void {
    return this.conversationState$.subscribe(listener);
  }

  /**
   * Subscribe to the confirm-window command (held / refined / cleared). Fires
   * immediately with the current value, then on every change. Used by the
   * per-tab pending-command badge.
   */
  onPendingCommandChange(listener: (command: string | null) => void): () => void {
    return this.pendingCommand$.subscribe(listener);
  }

  /** Cancel the command held in the confirm window (✕ badge / voice cancel). */
  cancelPending(): void {
    this.controller?.cancelPending();
  }

  /** Subscribe to mic mute state. Fires immediately, then on every change. */
  onMuteChange(listener: (muted: boolean) => void): () => void {
    return this.muted$.subscribe(listener);
  }

  /** Toggle the mic pause (no-op unless a conversation is running). */
  toggleMute(): void {
    this.controller?.toggleMute();
  }

  // ---- dictation mode ----

  /** Start (or cancel, if already capturing) a one-shot dictation. */
  async startDictation(): Promise<void> {
    if (!this.hasBridgeConfig()) {
      this.noticeMissingConfig();
      return;
    }
    await this.dictation.toggle();
  }

  /** Subscribe to dictation capture state (for the mic button active look). */
  onDictationStateChange(listener: (state: DictationState) => void): () => void {
    return this.dictation.onStateChange(listener);
  }

  // ---- teardown ----

  /** Full teardown on plugin unload: stop conversation, dictation, and bridge. */
  async dispose(): Promise<void> {
    await this.disable();
    this.dictation.dispose();
    await this.residentBridge.shutdown();
  }

  // ---- helpers ----

  /** Whether the bridge script path is configured (buttons are always shown,
   *  but need a path before they can do anything). */
  private hasBridgeConfig(): boolean {
    return (this.plugin.settings.voiceBridgeScriptPath?.trim() ?? '') !== '';
  }

  private noticeMissingConfig(): void {
    new Notice('Voice: set the bridge script path in Claudian settings first.');
  }

  /** Resolve the Python bridge launch config from settings, or explain why not. */
  private resolveConfig(): VoiceRuntimeConfig | null {
    const settings = this.plugin.settings;
    const bridgeScriptPath = settings.voiceBridgeScriptPath?.trim() ?? '';
    if (bridgeScriptPath === '') {
      this.noticeMissingConfig();
      return null;
    }
    const pythonPath = settings.voicePythonPath?.trim() || 'python3';
    return {
      pythonPath,
      bridgeScriptPath,
      // The bridge imports the voicecode package relative to its own directory.
      cwd: dirname(bridgeScriptPath),
    };
  }
}
