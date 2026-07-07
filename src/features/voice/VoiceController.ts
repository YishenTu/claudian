// The voice turn state machine: wires the Python audio bridge to the active
// Claudian chat tab. It arms the mic, submits transcripts as if typed, peels
// the streamed reply into speakable clips, and handles barge-in.
//
// Half-duplex by design (the bridge captures OR plays, never both), mirroring
// code-tui's `ui/voice.go` turn loop. The chunking/cleaning is delegated to the
// pure ports in `speakable.ts` and `sentences.ts`.

import { Notice } from 'obsidian';

import type { StreamChunk } from '../../core/types';
import type ClaudianPlugin from '../../main';
import type { TabData } from '../chat/tabs/types';
import type { BridgeLease } from './ResidentBridge';
import { chunkForSpeech, splitSentences } from './sentences';
import { speakable } from './speakable';
import { type VoiceBridge, type VoiceEvent } from './VoiceBridge';
import { isCancelPhrase } from './voiceCommands';

/**
 * Half-duplex turn state. The mic is never armed while speaking.
 * - `pending` a spoken command is held in the confirm window, cancellable by
 *   voice or the ✕ badge; the mic stays armed to catch a cancel phrase.
 * - `muted`   the mic is paused (button) but the session/bridge stays warm.
 */
export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'pending' | 'muted';

/** Fallback confirm-window hold (ms) when the setting is absent/invalid. */
const DEFAULT_CONFIRM_WINDOW_MS = 2000;

/** Minimal event bus the StreamController forwards chunks into. */
export interface VoiceStreamBus {
  subscribe(listener: (chunk: StreamChunk) => void): () => void;
}

/** Where the Python bridge lives and how to launch it. */
export interface VoiceRuntimeConfig {
  pythonPath: string;
  bridgeScriptPath: string;
  cwd: string;
}

// How long the same transcript text is treated as a duplicate-burst echo of
// itself and dropped (matches voice.go's transcriptDupWindow).
const TRANSCRIPT_DUP_WINDOW_MS = 1500;

export class VoiceController {
  private readonly plugin: ClaudianPlugin;
  private readonly bus: VoiceStreamBus;
  // Acquires the shared resident bridge on start; released on stop. The
  // controller never closes the bridge itself — the ResidentBridge owns that.
  private readonly acquireBridge: () => Promise<BridgeLease>;

  private bridge: VoiceBridge | null = null;
  private lease: BridgeLease | null = null;
  private state: VoiceState = 'idle';

  private unsubscribeBridge: (() => void) | null = null;
  private unsubscribeBus: (() => void) | null = null;

  // Live state listeners (e.g. the per-tab waveform indicator). Notified on
  // every state transition so the UI can animate from turn state alone.
  private readonly stateListeners = new Set<(state: VoiceState) => void>();

  // Confirm-window buffer: a spoken command is held here (not yet submitted) so
  // it can be cancelled by voice ("cancel"/"scratch that") or the ✕ badge. More
  // speech during the window replaces it and restarts the hold (refine-by-pause).
  private pendingCommand: string | null = null;
  private confirmTimer: number | null = null;
  private readonly pendingListeners = new Set<(command: string | null) => void>();

  // Mute: pause mic capture while keeping the bridge/session warm. Speaking is
  // allowed to finish; the mic parks in `muted` instead of re-arming.
  private muted = false;
  private readonly muteListeners = new Set<(muted: boolean) => void>();

  // Running buffer of streamed assistant text; complete sentences are peeled off
  // for TTS and the incomplete tail is carried to the next chunk.
  private speakBuffer = '';
  // Count of speak clips sent but not yet acknowledged (speak-done/interrupted).
  private pendingSpeaks = 0;
  // The assistant turn has finished streaming; re-arm the mic once TTS drains.
  private turnComplete = false;

  // Transcript dedupe (content + time) to drop sub-second duplicate bursts.
  private lastTranscript = '';
  private lastTranscriptAt = 0;

  constructor(
    plugin: ClaudianPlugin,
    bus: VoiceStreamBus,
    acquireBridge: () => Promise<BridgeLease>,
  ) {
    this.plugin = plugin;
    this.bus = bus;
    this.acquireBridge = acquireBridge;
  }

  /** Acquire the shared bridge, subscribe to audio + stream events, arm mic. */
  async start(): Promise<void> {
    if (this.bridge) {
      return;
    }

    // Cold start (model load) surfaces its own Notice/errors in ResidentBridge.
    const lease = await this.acquireBridge();
    this.lease = lease;
    this.bridge = lease.bridge;
    this.unsubscribeBridge = lease.bridge.onEvent((event) => this.handleBridgeEvent(event));

    // Tap the chat stream only once the bridge is live, so text→speech is wired.
    this.unsubscribeBus = this.bus.subscribe((chunk) => this.handleStreamChunk(chunk));

    this.armListen();
  }

  /** Tear everything down and return to idle. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;

    this.bridge = null;
    this.clearConfirmTimer();
    this.setPendingCommand(null);
    this.setMuted(false);
    this.resetTurnBuffers();
    this.setState('idle');

    // Release our hold on the shared bridge; ResidentBridge handles linger/close.
    const lease = this.lease;
    this.lease = null;
    lease?.release();
  }

  /** Current turn state (exposed for status/debug). */
  getState(): VoiceState {
    return this.state;
  }

  /**
   * Subscribe to turn-state transitions. The listener fires immediately with the
   * current state, then on every change. Returns an unsubscribe function.
   */
  onStateChange(listener: (state: VoiceState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** The command currently held in the confirm window, or null. */
  getPendingCommand(): string | null {
    return this.pendingCommand;
  }

  /**
   * Subscribe to confirm-window changes (a command is held, refined, or
   * cleared). Fires immediately with the current value, then on every change.
   */
  onPendingCommandChange(listener: (command: string | null) => void): () => void {
    this.pendingListeners.add(listener);
    listener(this.pendingCommand);
    return () => {
      this.pendingListeners.delete(listener);
    };
  }

  /** Whether the mic is currently paused (muted). */
  isMuted(): boolean {
    return this.muted;
  }

  /** Subscribe to mute changes. Fires immediately, then on every change. */
  onMuteChange(listener: (muted: boolean) => void): () => void {
    this.muteListeners.add(listener);
    listener(this.muted);
    return () => {
      this.muteListeners.delete(listener);
    };
  }

  /** Flip the mic pause on/off. */
  toggleMute(): void {
    this.setMuted(!this.muted);
  }

  /**
   * Cancel the command held in the confirm window (voice "cancel" or the ✕
   * badge) and return to normal listening. No-op if nothing is pending.
   */
  cancelPending(): void {
    if (this.pendingCommand === null) {
      return;
    }
    this.clearConfirmTimer();
    this.setPendingCommand(null);
    this.armListen();
  }

  /** Transition to a new state and notify listeners (no-op if unchanged). */
  private setState(next: VoiceState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      try {
        listener(next);
      } catch {
        // A listener error must never disrupt the turn loop.
      }
    }
  }

  // ---- bridge events ----

  private handleBridgeEvent(event: VoiceEvent): void {
    switch (event.type) {
      case 'transcript':
        this.handleTranscript(event.text ?? '');
        break;
      case 'speak-done':
        this.handleSpeakDone();
        break;
      case 'interrupted':
        // An interrupt we initiated (barge-in) already moved us to listening and
        // reset the counters; nothing more to do here.
        break;
      case 'error': {
        new Notice(`Voice error: ${event.message ?? 'unknown'}`);
        void this.stop();
        break;
      }
      default:
        // ready/initialized/status are handled elsewhere or ignored.
        break;
    }
  }

  private handleTranscript(text: string): void {
    const trimmed = text.trim();

    // Empty transcript = silence/noise. Re-arm depending on where we are.
    if (trimmed === '') {
      if (this.state === 'pending') {
        // Keep catching a cancel phrase until the hold timer fires.
        this.armForConfirm();
      } else if (this.state === 'listening') {
        this.armListen();
      }
      return;
    }

    // Inside the confirm window: the utterance is either a cancel or a refine.
    if (this.state === 'pending') {
      if (isCancelPhrase(trimmed)) {
        this.cancelPending();
        return;
      }
      // Refine: replace the held command and restart the hold (pause-to-submit).
      this.startConfirmWindow(trimmed);
      return;
    }

    // Content + time dedupe: drop a repeat of the last accepted text in-window.
    const now = Date.now();
    if (trimmed === this.lastTranscript && now - this.lastTranscriptAt < TRANSCRIPT_DUP_WINDOW_MS) {
      return;
    }
    this.lastTranscript = trimmed;
    this.lastTranscriptAt = now;

    const tab = this.getActiveTab();
    if (!tab || !tab.controllers.inputController) {
      new Notice('Voice: no active Claudian tab to send to.');
      // Nothing to submit to; stay listening so the next tab focus can pick up.
      this.armListen();
      return;
    }

    // Barge-in: a transcript arriving mid-reply cuts the current turn and starts
    // a fresh one. Cancel the in-flight stream, cut audio, and clear the queue.
    if (this.state === 'speaking' || this.state === 'thinking') {
      if (tab.state.isStreaming) {
        tab.controllers.inputController.cancelStreaming();
      }
      this.bridge?.interrupt();
      this.resetTurnBuffers();
    }

    // Confirm window: hold the command so it can be cancelled before it runs.
    // A window of 0 submits immediately (legacy behavior).
    if (this.confirmWindowMs() > 0) {
      this.startConfirmWindow(trimmed);
      return;
    }
    this.submitCommand(trimmed);
  }

  private handleSpeakDone(): void {
    if (this.pendingSpeaks > 0) {
      this.pendingSpeaks -= 1;
    }
    this.maybeReArm();
  }

  // ---- chat stream tap ----

  private handleStreamChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text':
        this.ingestText(chunk.content);
        break;
      case 'done':
        this.finishTurn();
        break;
      default:
        // thinking/tool/usage chunks are not spoken.
        break;
    }
  }

  /** Accumulate streamed text and speak whole sentences as they complete. */
  private ingestText(content: string): void {
    if (this.bridge === null) {
      return;
    }
    this.speakBuffer += content;
    const { sentences, remainder } = splitSentences(this.speakBuffer);
    this.speakBuffer = remainder;
    for (const sentence of sentences) {
      this.speakClips(sentence);
    }
  }

  /** Flush the incomplete tail, then re-arm once the last clip finishes. */
  private finishTurn(): void {
    if (this.speakBuffer.trim() !== '') {
      // The trailing fragment never got a terminator; speak it as-is.
      this.speakClips(this.speakBuffer);
    }
    this.speakBuffer = '';
    this.turnComplete = true;
    this.maybeReArm();
  }

  /** Clean → chunk → enqueue one sentence's worth of TTS clips. */
  private speakClips(sentence: string): void {
    const prose = speakable(sentence);
    if (prose === '') {
      return;
    }
    for (const clip of chunkForSpeech(prose)) {
      this.bridge?.speak(clip);
      this.pendingSpeaks += 1;
      this.setState('speaking');
    }
  }

  // ---- helpers ----

  /** Re-arm the mic once the turn is done streaming and TTS has fully drained. */
  private maybeReArm(): void {
    if (this.turnComplete && this.pendingSpeaks === 0) {
      this.turnComplete = false;
      this.armListen();
    }
  }

  private armListen(): void {
    if (!this.bridge) {
      this.setState('idle');
      return;
    }
    // Muted: keep the session warm but don't capture; park in `muted`.
    if (this.muted) {
      this.setState('muted');
      return;
    }
    this.bridge.listen();
    this.setState('listening');
  }

  /** Re-arm the mic during the confirm window WITHOUT leaving `pending` state,
   *  so the badge stays up while we listen only for a cancel phrase. */
  private armForConfirm(): void {
    // If muted, we can't hear a cancel — the hold timer still submits on expiry,
    // and the ✕ badge remains available.
    if (!this.bridge || this.muted) {
      return;
    }
    this.bridge.listen();
  }

  // ---- confirm window ----

  /** Resolve the configured hold window (ms), clamped to a sane non-negative. */
  private confirmWindowMs(): number {
    const raw = this.plugin.settings.voiceConfirmWindowMs;
    return typeof raw === 'number' && raw >= 0 ? raw : DEFAULT_CONFIRM_WINDOW_MS;
  }

  /** Hold a command in the confirm window and (re)start the cancel timer. */
  private startConfirmWindow(command: string): void {
    this.clearConfirmTimer();
    this.setPendingCommand(command);
    this.setState('pending');
    this.armForConfirm();
    this.confirmTimer = window.setTimeout(() => {
      this.confirmTimer = null;
      const held = this.pendingCommand;
      this.setPendingCommand(null);
      if (held !== null) {
        this.submitCommand(held);
      } else {
        this.armListen();
      }
    }, this.confirmWindowMs());
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer !== null) {
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  /** Submit a command to the active tab as if the user typed it. */
  private submitCommand(command: string): void {
    const tab = this.getActiveTab();
    if (!tab || !tab.controllers.inputController) {
      new Notice('Voice: no active Claudian tab to send to.');
      this.armListen();
      return;
    }
    this.setState('thinking');
    // sendMessage owns its own error handling; guard the promise so a rejection
    // can't go unhandled.
    void tab.controllers.inputController.sendMessage({ content: command }).catch(() => {
      /* sendMessage surfaces its own errors via Notice */
    });
  }

  private setPendingCommand(command: string | null): void {
    if (this.pendingCommand === command) {
      return;
    }
    this.pendingCommand = command;
    for (const listener of this.pendingListeners) {
      try {
        listener(command);
      } catch {
        // A listener error must never disrupt the turn loop.
      }
    }
  }

  // ---- mute ----

  /** Pause/resume mic capture while keeping the bridge warm. */
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

    if (muted) {
      // Pause now if the mic is (or would be) live. Speaking is left to finish;
      // maybeReArm/armListen then parks in `muted` when it's the mic's turn.
      if (this.state === 'listening' || this.state === 'pending') {
        this.bridge?.interrupt();
        // Drop any held command — nothing should auto-submit while paused.
        this.clearConfirmTimer();
        this.setPendingCommand(null);
        this.setState('muted');
      }
    } else if (this.state === 'muted') {
      // Unmute from a paused mic: resume listening.
      this.armListen();
    }
  }

  private resetTurnBuffers(): void {
    this.speakBuffer = '';
    this.pendingSpeaks = 0;
    this.turnComplete = false;
  }

  private getActiveTab(): TabData | null {
    return this.plugin.getView()?.getActiveTab() ?? null;
  }
}
