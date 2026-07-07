// One-shot dictation: acquire the shared bridge, listen once, and drop the
// resulting transcript into the active tab's chat input. Unlike the full
// conversation loop (VoiceController), dictation never speaks and never submits
// on its own unless auto-send is enabled — it hands the text to the composer.
//
// Lifecycle mirrors a single listen(): acquire on start, release once the
// transcript (or an error/cancel) lands. Tapping the mic again while listening
// cancels the in-flight capture.

import { Notice } from 'obsidian';

import type ClaudianPlugin from '../../main';
import type { TabData } from '../chat/tabs/types';
import { autoResizeTextarea } from '../chat/ui/textareaResize';
import { mergeDictation } from './dictationInsert';
import type { BridgeLease } from './ResidentBridge';
import type { VoiceBridge, VoiceEvent } from './VoiceBridge';

/** Dictation lifecycle, exposed so the mic button can reflect capture state. */
export type DictationState = 'idle' | 'listening';

export class DictationController {
  private readonly plugin: ClaudianPlugin;
  private readonly acquireBridge: () => Promise<BridgeLease>;

  private lease: BridgeLease | null = null;
  private bridge: VoiceBridge | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: DictationState = 'idle';

  private readonly stateListeners = new Set<(state: DictationState) => void>();

  constructor(plugin: ClaudianPlugin, acquireBridge: () => Promise<BridgeLease>) {
    this.plugin = plugin;
    this.acquireBridge = acquireBridge;
  }

  /** True while a capture is in flight. */
  isListening(): boolean {
    return this.state === 'listening';
  }

  /** Subscribe to dictation state; fires immediately then on every change. */
  onStateChange(listener: (state: DictationState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Toggle dictation: start a one-shot capture, or cancel the in-flight one.
   * Returns once the capture has been armed (not once the transcript lands).
   */
  async toggle(): Promise<void> {
    if (this.state === 'listening') {
      this.cancel();
      return;
    }
    await this.start();
  }

  /** Cancel an in-flight capture and release the bridge. */
  cancel(): void {
    if (this.state !== 'listening') {
      return;
    }
    // interrupt() cuts any capture; we release regardless of what the bridge
    // reports next, so a late transcript after cancel is ignored (bridge null).
    this.bridge?.interrupt();
    this.teardown();
  }

  /** Force release on plugin unload / feature disable. */
  dispose(): void {
    this.teardown();
  }

  // ---- internals ----

  private async start(): Promise<void> {
    let lease: BridgeLease;
    try {
      lease = await this.acquireBridge();
    } catch {
      // ResidentBridge surfaced the reason via Notice.
      return;
    }

    this.lease = lease;
    this.bridge = lease.bridge;
    this.unsubscribe = lease.bridge.onEvent((event) => this.handleEvent(event));
    this.setState('listening');
    lease.bridge.listen();
  }

  private handleEvent(event: VoiceEvent): void {
    switch (event.type) {
      case 'transcript':
        this.handleTranscript(event.text ?? '');
        break;
      case 'error':
        new Notice(`Voice error: ${event.message ?? 'unknown'}`);
        this.teardown();
        break;
      default:
        // ready/initialized/status/speak-done/interrupted are not relevant here.
        break;
    }
  }

  private handleTranscript(text: string): void {
    const trimmed = text.trim();
    // A one-shot capture is done regardless of content; release the bridge.
    this.teardown();

    if (trimmed === '') {
      return; // silence/noise — nothing to insert.
    }

    const tab = this.plugin.getView()?.getActiveTab() ?? null;
    if (!tab || !tab.controllers.inputController) {
      new Notice('Voice: no active Claudian tab to dictate into.');
      return;
    }

    if (this.plugin.settings.voiceDictationAutoSend === true) {
      void tab.controllers.inputController.sendMessage({ content: trimmed }).catch(() => {
        /* sendMessage surfaces its own errors via Notice */
      });
      return;
    }

    this.insertIntoInput(tab, trimmed);
  }

  /** Splice the transcript at the caret and fire an input event so the composer
   *  resizes and the send button enables — matching the typed-input path. */
  private insertIntoInput(tab: TabData, transcript: string): void {
    const inputEl = tab.dom.inputEl;
    const caret = inputEl.selectionStart ?? inputEl.value.length;
    const { value, caret: nextCaret } = mergeDictation(inputEl.value, transcript, caret);

    inputEl.value = value;
    inputEl.setSelectionRange(nextCaret, nextCaret);
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    autoResizeTextarea(inputEl);
    inputEl.focus();
  }

  private teardown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bridge = null;
    const lease = this.lease;
    this.lease = null;
    lease?.release();
    this.setState('idle');
  }

  private setState(next: DictationState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    for (const listener of this.stateListeners) {
      try {
        listener(next);
      } catch {
        // A listener error must never disrupt dictation.
      }
    }
  }
}
