import type { ChatState } from '@/features/chat/state/ChatState';
import { FLAVOR_TEXTS } from '@/features/chat/turns/flavorTexts';
import { formatDurationMmSs } from '@/utils/date';

export interface ThinkingIndicatorDeps {
  state: ChatState;
  getMessagesEl: () => HTMLElement | null;
  updateQueueIndicator: () => void;
  scrollToBottom: () => void;
}

/** Debounce delay before showing the indicator (ms). */
const SHOW_DELAY_MS = 400;
/** Longer delay after streamed text, so token gaps do not flicker the indicator. */
const TEXT_PAUSE_DELAY_MS = 1500;

/**
 * The waiting status shown while a response streams without visible output.
 * Scheduled work is fenced by the stream generation that requested it.
 */
interface WindowTimer {
  readonly id: number;
  readonly window: Window;
}

export class ThinkingIndicator {
  /** When the pending indicator is due, so an earlier request can replace a later one. */
  #dueAt = 0;
  /** An explicit status (such as compaction) stays with its response across hide and resume. */
  #explicit: { messageId: string | null; text: string; cls?: string } | null = null;
  /** Stream generation that owns the current indicator; a superseded turn's indicator is discarded. */
  #generation: number | null = null;
  /** Generation whose due indicator an open prompt withheld; the prompt's settlement owes it a show. */
  #blockedGeneration: number | null = null;
  /** The shown indicator; it may be detached from the DOM while a thinking block replaces it. */
  #el: HTMLElement | null = null;
  /** Pending show, debounced after inactivity. */
  #showTimer: WindowTimer | null = null;
  /** Ticks the elapsed time in the shown indicator. */
  #elapsedTimer: WindowTimer | null = null;

  constructor(private readonly deps: ThinkingIndicatorDeps) {}

  /**
   * Schedules the indicator after a short delay, so output arriving first keeps it hidden.
   * Explicit text replaces flavor text for the current response until {@link endExplicit}.
   * A model thinking block takes priority over the indicator.
   */
  show(overrideText?: string, overrideCls?: string): void {
    this.#schedule(SHOW_DELAY_MS, overrideText, overrideCls);
  }

  /** Each text chunk restarts the pause; the indicator returns only once text stops arriving. */
  afterTextPause(): void {
    if (this.deps.state.isStreaming) this.#schedule(TEXT_PAUSE_DELAY_MS);
  }

  /**
   * Brings the indicator back after a prompt settles, while the turn continues without visible output.
   * A prompt resumes the response it interrupted, or the current response whose own indicator it withheld;
   * it never starts one in a response that neither it nor the open prompt touched.
   */
  resume(generation: number): void {
    const { state } = this.deps;
    if (!state.isStreaming) return;
    if (state.streamGeneration === generation || this.#blockedGeneration === state.streamGeneration) this.show();
  }

  /** Hides the indicator and cancels any pending show. */
  hide(): void {
    this.#cancelShow();
    // Response start time is preserved for duration capture.
    this.stopElapsedTimer();
    this.#el?.remove();
    this.#el = null;
    this.deps.state.waitingStatus = null;
    this.#blockedGeneration = null;
  }

  /** Stops the elapsed-time tick, leaving a shown indicator in place. */
  stopElapsedTimer(): void {
    const timer = this.#elapsedTimer;
    this.#elapsedTimer = null;
    timer?.window.clearInterval(timer.id);
  }

  /** Ends an explicit status; later waiting in the same response shows ordinary flavor text. */
  endExplicit(): void {
    this.hide();
    this.#explicit = null;
  }

  detachPresentation(): void { this.hide(); }

  dispose(): void {
    this.endExplicit();
  }

  #cancelShow(): void {
    const timer = this.#showTimer;
    this.#showTimer = null;
    timer?.window.clearTimeout(timer.id);
  }

  #schedule(delay: number, overrideText?: string, overrideCls?: string): void {
    const { state } = this.deps;
    const generation = state.streamGeneration;
    if (this.#generation !== generation) {
      if (this.#el || this.#showTimer) this.hide();
      this.#generation = generation;
    }

    const isExplicitRequest = !!overrideText;
    if (overrideText) {
      this.#explicit = { messageId: state.response.messageId, text: overrideText, cls: overrideCls };
    } else if (this.#explicit && this.#explicit.messageId === state.response.messageId) {
      ({ text: overrideText, cls: overrideCls } = this.#explicit);
    }

    const contentEl = state.currentContentEl;
    if (!contentEl) return;

    // A pending show keeps its deadline; repeated requests must not postpone it.
    const dueAt = performance.now() + delay;
    if (this.#showTimer) {
      if (!isExplicitRequest && this.#dueAt <= dueAt) return;
      this.#cancelShow();
    }

    if (state.currentThinkingBlock) return;

    if (this.#el) {
      contentEl.appendChild(this.#el);
      this.deps.updateQueueIndicator();
      this.deps.scrollToBottom();
      return;
    }

    const timerWindow = contentEl.ownerDocument.defaultView ?? window;
    this.#dueAt = dueAt;
    const timer: WindowTimer = {
      id: timerWindow.setTimeout(() => {
        if (this.#showTimer === timer) this.#showTimer = null;
        // A pending user interaction takes the place of the indicator until it settles,
        // and a superseded stream (new chat, teardown) no longer owns the indicator.
        if (state.streamGeneration !== generation) return;
        if (state.requiresAction) {
          this.#blockedGeneration = generation;
          return;
        }
        const target = state.currentContentEl;
        if (!target || this.#el || state.currentThinkingBlock) return;
        this.#blockedGeneration = null;
        this.#render(target, timerWindow, overrideText, overrideCls);
      }, delay),
      window: timerWindow,
    };
    this.#showTimer = timer;
  }

  #render(target: HTMLElement, timerWindow: Window, overrideText?: string, overrideCls?: string): void {
    const { state } = this.deps;
    const cls = overrideCls
      ? `claudian-thinking ${overrideCls}`
      : 'claudian-thinking';
    const el = target.createDiv({ cls });
    this.#el = el;
    const text = overrideText || FLAVOR_TEXTS[Math.floor(Math.random() * FLAVOR_TEXTS.length)];
    el.createSpan({ text });
    state.waitingStatus = text;

    const timerSpan = el.createSpan({ cls: 'claudian-thinking-hint' });
    const updateTimer = () => {
      if (!state.responseStartTime) return;
      // A disconnected span means the indicator was replaced; stop its orphaned interval.
      if (!timerSpan.isConnected) {
        this.stopElapsedTimer();
        return;
      }
      const elapsedSeconds = Math.floor((performance.now() - state.responseStartTime) / 1000);
      timerSpan.setText(` (esc to interrupt · ${formatDurationMmSs(elapsedSeconds)})`);
    };
    updateTimer();

    this.stopElapsedTimer();
    const thinkingWindow = target.ownerDocument.defaultView ?? timerWindow;
    this.#elapsedTimer = { id: thinkingWindow.setInterval(updateTimer, 1000), window: thinkingWindow };
    this.deps.scrollToBottom();
  }
}
