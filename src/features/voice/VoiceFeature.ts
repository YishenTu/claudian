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
import { VoiceController, type VoiceRuntimeConfig, type VoiceState, type VoiceStreamBus } from './VoiceController';

/**
 * A tiny synchronous fan-out bus for stream chunks. The StreamController calls
 * `emit` for every chunk it handles; the VoiceController subscribes while voice
 * is running. When there are no subscribers, `emit` is a no-op.
 */
export class VoiceStreamBusImpl implements VoiceStreamBus {
  private readonly listeners = new Set<(chunk: StreamChunk) => void>();

  emit(chunk: StreamChunk): void {
    if (this.listeners.size === 0) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch {
        // A voice-side error must never disrupt chat rendering.
      }
    }
  }

  subscribe(listener: (chunk: StreamChunk) => void): () => void {
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

  // Conversation-state listeners (per-tab waveform indicators). The current
  // state is replayed to new subscribers so a freshly-built tab reflects an
  // already-running session.
  private readonly conversationStateListeners = new Set<(state: VoiceState) => void>();
  private conversationState: VoiceState = 'idle';
  private unsubscribeControllerState: (() => void) | null = null;

  // Confirm-window + mute state, cached here so per-tab controls (which outlive
  // any single controller instance) can subscribe once and stay in sync.
  private readonly pendingCommandListeners = new Set<(command: string | null) => void>();
  private pendingCommand: string | null = null;
  private unsubscribeControllerPending: (() => void) | null = null;

  private readonly muteListeners = new Set<(muted: boolean) => void>();
  private muted = false;
  private unsubscribeControllerMute: (() => void) | null = null;

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

  /** Back-compat alias for the existing `toggle-voice-mode` command. */
  async toggle(): Promise<void> {
    await this.toggleConversation();
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
      // Reflect controller state into the shared conversation-state stream so
      // per-tab waveform indicators animate live.
      this.unsubscribeControllerState = controller.onStateChange((state) => {
        this.setConversationState(state);
      });
      // Fan out the confirm-window + mute state to per-tab controls too.
      this.unsubscribeControllerPending = controller.onPendingCommandChange((command) => {
        this.setPendingCommand(command);
      });
      this.unsubscribeControllerMute = controller.onMuteChange((muted) => {
        this.setMuted(muted);
      });
      await controller.start();
      this.controller = controller;
      new Notice('Voice mode on — listening.');
    } catch {
      // VoiceController.start() surfaced the failure via Notice (or the bridge
      // did); just stay disabled and drop the state subscriptions.
      this.detachControllerSubscriptions();
      this.controller = null;
      this.setConversationState('idle');
      this.setPendingCommand(null);
      this.setMuted(false);
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
    this.setConversationState('idle');
    this.setPendingCommand(null);
    this.setMuted(false);
  }

  /** Drop all live controller subscriptions (state, pending, mute). */
  private detachControllerSubscriptions(): void {
    this.unsubscribeControllerState?.();
    this.unsubscribeControllerState = null;
    this.unsubscribeControllerPending?.();
    this.unsubscribeControllerPending = null;
    this.unsubscribeControllerMute?.();
    this.unsubscribeControllerMute = null;
  }

  /**
   * Subscribe to conversation turn-state. Fires immediately with the current
   * state, then on every change. Used by per-tab waveform indicators.
   */
  onConversationStateChange(listener: (state: VoiceState) => void): () => void {
    this.conversationStateListeners.add(listener);
    listener(this.conversationState);
    return () => {
      this.conversationStateListeners.delete(listener);
    };
  }

  /**
   * Subscribe to the confirm-window command (held / refined / cleared). Fires
   * immediately with the current value, then on every change. Used by the
   * per-tab pending-command badge.
   */
  onPendingCommandChange(listener: (command: string | null) => void): () => void {
    this.pendingCommandListeners.add(listener);
    listener(this.pendingCommand);
    return () => {
      this.pendingCommandListeners.delete(listener);
    };
  }

  /** Cancel the command held in the confirm window (✕ badge / voice cancel). */
  cancelPending(): void {
    this.controller?.cancelPending();
  }

  /** Subscribe to mic mute state. Fires immediately, then on every change. */
  onMuteChange(listener: (muted: boolean) => void): () => void {
    this.muteListeners.add(listener);
    listener(this.muted);
    return () => {
      this.muteListeners.delete(listener);
    };
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

  private setConversationState(state: VoiceState): void {
    if (this.conversationState === state) {
      return;
    }
    this.conversationState = state;
    for (const listener of this.conversationStateListeners) {
      try {
        listener(state);
      } catch {
        // A listener error must never disrupt the turn loop.
      }
    }
  }

  private setPendingCommand(command: string | null): void {
    if (this.pendingCommand === command) {
      return;
    }
    this.pendingCommand = command;
    for (const listener of this.pendingCommandListeners) {
      try {
        listener(command);
      } catch {
        // A listener error must never disrupt the turn loop.
      }
    }
  }

  private setMuted(muted: boolean): void {
    if (this.muted === muted) {
      return;
    }
    this.muted = muted;
    for (const listener of this.muteListeners) {
      try {
        listener(muted);
      } catch {
        // A listener error must never disrupt the turn loop.
      }
    }
  }

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
