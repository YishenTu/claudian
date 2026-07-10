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
import { StateStream } from './StateStream';
import type { VoiceBridge, VoiceEvent } from './VoiceBridge';

/** Dictation lifecycle, exposed so the mic button can reflect capture state. */
export type DictationState = 'idle' | 'listening';

export class DictationController {
  private readonly plugin: ClaudianPlugin;
  private readonly acquireBridge: () => Promise<BridgeLease>;

  private lease: BridgeLease | null = null;
  private bridge: VoiceBridge | null = null;
  private unsubscribe: (() => void) | null = null;
  // Guards start() while the bridge is still cold-starting, so a rapid second
  // tap can't acquire a duplicate lease (the first handle would leak).
  private starting = false;

  private readonly state$ = new StateStream<DictationState>('idle');

  constructor(plugin: ClaudianPlugin, acquireBridge: () => Promise<BridgeLease>) {
    this.plugin = plugin;
    this.acquireBridge = acquireBridge;
  }

  /** True while a capture is in flight. */
  isListening(): boolean {
    return this.state$.get() === 'listening';
  }

  /** Subscribe to dictation state; fires immediately then on every change. */
  onStateChange(listener: (state: DictationState) => void): () => void {
    return this.state$.subscribe(listener);
  }

  /**
   * Toggle dictation: start a one-shot capture, or cancel the in-flight one.
   * Returns once the capture has been armed (not once the transcript lands).
   */
  async toggle(): Promise<void> {
    if (this.isListening()) {
      this.cancel();
      return;
    }
    await this.start();
  }

  /** Cancel an in-flight capture and release the bridge. */
  cancel(): void {
    if (!this.isListening()) {
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
    if (this.starting) {
      return;
    }
    this.starting = true;
    let lease: BridgeLease;
    try {
      lease = await this.acquireBridge();
    } catch {
      // ResidentBridge surfaced the reason via Notice.
      return;
    } finally {
      this.starting = false;
    }

    this.lease = lease;
    this.bridge = lease.bridge;
    this.unsubscribe = lease.bridge.onEvent((event) => this.handleEvent(event));
    this.state$.set('listening');
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
    this.state$.set('idle');
  }
}
