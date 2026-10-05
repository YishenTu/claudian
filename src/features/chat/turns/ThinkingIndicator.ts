import type { ChatState } from '@/features/chat/state/ChatState';
import { FLAVOR_TEXTS } from '@/features/chat/turns/flavorTexts';
import { formatDurationMmSs } from '@/utils/date';

export interface ThinkingIndicatorDeps {
  state: ChatState;
  getMessagesEl: () => HTMLElement;
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
export class ThinkingIndicator {
  /** When the pending indicator is due, so an earlier request can replace a later one. */
  #dueAt = 0;
  /** An explicit status (such as compaction) stays with its response across hide and resume. */
  #explicit: { contentEl: HTMLElement; text: string; cls?: string } | null = null;
  /** Stream generation that owns the current indicator; a superseded turn's indicator is discarded. */
  #generation: number | null = null;
  /** Generation whose due indicator an open prompt withheld; the prompt's settlement owes it a show. */
  #blockedGeneration: number | null = null;

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
    const { state } = this.deps;

    if (state.thinkingIndicatorTimeout) {
      const activeWindow = this.deps.getMessagesEl().ownerDocument.defaultView ?? window;
      state.clearThinkingIndicatorTimeout(activeWindow);
    }

    // Clear the timer interval but preserve responseStartTime for duration capture.
    state.clearFlavorTimerInterval();

    if (state.thinkingEl) {
      state.thinkingEl.remove();
      state.thinkingEl = null;
    }
    state.waitingStatus = null;
    this.#blockedGeneration = null;
  }

  /** Ends an explicit status; later waiting in the same response shows ordinary flavor text. */
  endExplicit(): void {
    this.hide();
    this.#explicit = null;
  }

  dispose(): void {
    this.endExplicit();
  }

  #schedule(delay: number, overrideText?: string, overrideCls?: string): void {
    const { state } = this.deps;
    if (!state.currentContentEl) return;

    const generation = state.streamGeneration;
    if (this.#generation !== generation) {
      if (state.thinkingEl || state.thinkingIndicatorTimeout) this.hide();
      this.#generation = generation;
    }

    const isExplicitRequest = !!overrideText;
    if (overrideText) {
      this.#explicit = { contentEl: state.currentContentEl, text: overrideText, cls: overrideCls };
    } else if (this.#explicit?.contentEl === state.currentContentEl) {
      ({ text: overrideText, cls: overrideCls } = this.#explicit);
    }

    // A pending show keeps its deadline; repeated requests must not postpone it.
    const dueAt = performance.now() + delay;
    if (state.thinkingIndicatorTimeout) {
      if (!isExplicitRequest && this.#dueAt <= dueAt) return;
      const timerWindow = state.currentContentEl.ownerDocument.defaultView ?? window;
      state.clearThinkingIndicatorTimeout(timerWindow);
    }

    if (state.currentThinkingState) return;

    if (state.thinkingEl) {
      state.currentContentEl.appendChild(state.thinkingEl);
      this.deps.updateQueueIndicator();
      this.deps.scrollToBottom();
      return;
    }

    const timerWindow = state.currentContentEl.ownerDocument.defaultView ?? window;
    this.#dueAt = dueAt;
    state.setThinkingIndicatorTimeout(timerWindow.setTimeout(() => {
      state.setThinkingIndicatorTimeout(null, null);
      // A pending user interaction takes the place of the indicator until it settles,
      // and a superseded stream (new chat, teardown) no longer owns the indicator.
      if (state.streamGeneration !== generation) return;
      if (state.requiresAction) {
        this.#blockedGeneration = generation;
        return;
      }
      if (!state.currentContentEl || state.thinkingEl || state.currentThinkingState) return;
      this.#blockedGeneration = null;

      const cls = overrideCls
        ? `claudian-thinking ${overrideCls}`
        : 'claudian-thinking';
      state.thinkingEl = state.currentContentEl.createDiv({ cls });
      const text = overrideText || FLAVOR_TEXTS[Math.floor(Math.random() * FLAVOR_TEXTS.length)];
      state.thinkingEl.createSpan({ text });
      state.waitingStatus = text;

      const timerSpan = state.thinkingEl.createSpan({ cls: 'claudian-thinking-hint' });
      const updateTimer = () => {
        if (!state.responseStartTime) return;
        // A disconnected span means the indicator was replaced; stop its orphaned interval.
        if (!timerSpan.isConnected) {
          if (state.flavorTimerInterval) {
            state.clearFlavorTimerInterval();
          }
          return;
        }
        const elapsedSeconds = Math.floor((performance.now() - state.responseStartTime) / 1000);
        timerSpan.setText(` (esc to interrupt · ${formatDurationMmSs(elapsedSeconds)})`);
      };
      updateTimer();

      if (state.flavorTimerInterval) {
        state.clearFlavorTimerInterval();
      }
      const thinkingWindow = state.currentContentEl.ownerDocument.defaultView ?? timerWindow;
      state.setFlavorTimerInterval(thinkingWindow.setInterval(updateTimer, 1000), thinkingWindow);
      this.deps.scrollToBottom();
    }, delay), timerWindow);
  }
}
