import { type Keymap, Scope, setIcon } from 'obsidian';

import { t } from '../../../i18n/i18n';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';
import { setToolIcon } from '../rendering/ToolCallRenderer';
import type { ChatState } from '../state/ChatState';
import type { AssembledTabRuntime } from '../tabs/types';
import { formatActivityPreview, type ZenActivityTone } from './activityPreview';
import type { ZenModeSlots } from './types';

/** Reading intent captured before the transcript is relocated. */
export interface ZenScrollSnapshot {
  readonly top: number;
  readonly follow: boolean;
}

export interface ZenModePanelOptions {
  readonly keymap: Pick<Keymap, 'pushScope' | 'popScope'> | null;
  readonly historyExpanded: boolean;
  onHistoryExpandedChange(expanded: boolean): void;
  onOpenFullChat(): void;
}

const HOST_CLASS = 'claudian-zen-host';
const RESERVED_HEIGHT_PROPERTY = '--claudian-zen-reserved-height';

let panelSequence = 0;

export function captureZenScrollIntent(runtime: AssembledTabRuntime, top = runtime.dom.messagesEl.scrollTop): ZenScrollSnapshot {
  return { top, follow: runtime.state.autoScrollEnabled };
}

/** Follows new output when the reader was following, otherwise keeps their position. */
export function restoreZenScrollIntent(runtime: AssembledTabRuntime, snapshot: ZenScrollSnapshot): void {
  const messagesEl = runtime.dom.messagesEl;
  messagesEl.scrollTop = snapshot.follow ? messagesEl.scrollHeight : snapshot.top;
  // Relocation can emit geometry-only scroll events; they must not replace the captured intent.
  if (runtime.state.autoScrollEnabled !== snapshot.follow) runtime.state.autoScrollEnabled = snapshot.follow;
}

/**
 * Compact presentation for one attached runtime: a state-driven activity line,
 * the moved transcript behind a disclosure, and the moved composer, which keeps
 * its own send and cancel keys.
 * It holds presentation state only; chat owners keep drafts, queues and turns.
 */
export class ZenModePanel {
  readonly slots: ZenModeSlots;
  readonly #rootEl: HTMLElement;
  readonly #historyEl: HTMLElement;
  readonly #disclosureEl: HTMLButtonElement;
  readonly #previewEl: HTMLElement;
  readonly #previewIconEl: HTMLElement;
  #previewIconTool: string | null = null;
  readonly #destinationEl: HTMLElement;
  readonly #statusEl: HTMLElement;
  // A parentless scope keeps the active note's hotkeys away from zen input while it has focus.
  readonly #keyScope = new Scope();
  readonly #scrollTops = new WeakMap<AssembledTabRuntime, number>();
  #scopePushed = false;
  #runtime: AssembledTabRuntime | null = null;
  #unsubscribeMain: (() => void) | null = null;
  #sideState: ChatState | null = null;
  #unsubscribeSide: (() => void) | null = null;
  #pendingFrame: ScheduledAnimationFrame | null = null;
  #historyExpanded: boolean;
  #hasHistory = false;
  #lastTone: ZenActivityTone | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #destroyed = false;

  constructor(
    private readonly hostEl: HTMLElement,
    private readonly options: ZenModePanelOptions,
  ) {
    this.#historyExpanded = options.historyExpanded;
    const historyId = `claudian-zen-history-${++panelSequence}`;
    hostEl.addClass(HOST_CLASS);

    this.#rootEl = hostEl.createDiv({
      cls: 'claudian-container claudian-zen',
      attr: { role: 'region', 'aria-label': t('chat.zen.regionLabel') },
    });
    // The drawer groups the transcript and its preview line so expansion can open into the composer.
    const drawerEl = this.#rootEl.createDiv({ cls: 'claudian-zen-drawer' });
    this.#historyEl = drawerEl.createDiv({ cls: 'claudian-zen-history', attr: { id: historyId } });

    const previewId = `claudian-zen-preview-${panelSequence}`;
    const barEl = drawerEl.createDiv({ cls: 'claudian-zen-bar' });
    // The whole preview line toggles the transcript; its label names the action, the preview describes it.
    this.#disclosureEl = barEl.createEl('button', {
      cls: 'claudian-zen-disclosure',
      attr: { type: 'button', 'aria-controls': historyId, 'aria-describedby': previewId },
    });
    this.#disclosureEl.addEventListener('click', () => this.setHistoryExpanded(!this.#historyExpanded));

    this.#destinationEl = this.#disclosureEl.createSpan({
      cls: 'claudian-zen-destination claudian-hidden',
      text: t('chat.sideChat.title'),
    });
    this.#previewIconEl = this.#disclosureEl.createSpan({
      cls: 'claudian-zen-preview-icon claudian-hidden',
      attr: { 'aria-hidden': 'true' },
    });
    this.#previewEl = this.#disclosureEl.createSpan({ cls: 'claudian-zen-preview', attr: { id: previewId } });
    // Expanded, the chevron stands in for the preview line.
    const chevronEl = this.#disclosureEl.createSpan({
      cls: 'claudian-zen-disclosure-icon',
      attr: { 'aria-hidden': 'true' },
    });
    setIcon(chevronEl, 'chevron-down');

    const openEl = barEl.createEl('button', {
      cls: 'claudian-zen-open',
      attr: { type: 'button', 'aria-label': t('chat.zen.openFullChat') },
    });
    setIcon(openEl, 'maximize-2');
    openEl.addEventListener('click', () => this.options.onOpenFullChat());

    const composerEl = this.#rootEl.createDiv({ cls: 'claudian-zen-composer' });

    this.#statusEl = this.#rootEl.createDiv({ cls: 'claudian-zen-status', attr: { role: 'status' } });

    // Destination can change from controls inside the moved composer.
    for (const eventName of ['click', 'keyup', 'input'] as const) {
      this.#rootEl.addEventListener(eventName, () => this.#scheduleRender());
    }
    this.#rootEl.addEventListener('focusin', () => this.#pushKeyScope());
    this.#rootEl.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !this.#rootEl.contains(next)) this.#popKeyScope();
    });

    this.slots = { historyEl: this.#historyEl, composerEl };
    this.#applyHistoryExpanded();
    this.#observeReservedHeight();
  }

  get runtime(): AssembledTabRuntime | null {
    return this.#runtime;
  }

  /** Binds the displayed runtime; the snapshot is its position before relocation. */
  bind(runtime: AssembledTabRuntime | null, scroll: ZenScrollSnapshot | null = null): void {
    if (this.#destroyed) return;
    if (runtime === this.#runtime) {
      this.#scheduleRender();
      return;
    }
    this.#unsubscribeMain?.();
    this.#unsubscribeMain = null;
    this.#subscribeSide(null);
    this.#runtime = runtime;
    if (!runtime) return;

    if (scroll) this.#scrollTops.set(runtime, scroll.top);
    this.#unsubscribeMain = runtime.state.subscribeActivity(() => this.#scheduleRender());
    if (runtime.providerId) this.#rootEl.dataset.provider = runtime.providerId;
    else delete this.#rootEl.dataset.provider;
    if (this.#historyExpanded) {
      restoreZenScrollIntent(runtime, scroll ?? captureZenScrollIntent(runtime, this.#scrollTops.get(runtime)));
    }
    this.#render();
  }

  setHistoryExpanded(expanded: boolean): void {
    if (this.#destroyed || expanded === this.#historyExpanded) return;
    const runtime = this.#runtime;
    if (!expanded && runtime) this.#scrollTops.set(runtime, runtime.dom.messagesEl.scrollTop);
    this.#historyExpanded = expanded;
    this.#applyHistoryExpanded();
    // Hidden history receives no scroll events, so the live auto-scroll intent is current.
    if (expanded && runtime) {
      restoreZenScrollIntent(runtime, captureZenScrollIntent(runtime, this.#scrollTops.get(runtime)));
    }
    this.options.onHistoryExpandedChange(expanded);
  }

  /** Captures the reader's position before the transcript leaves this surface. */
  captureScroll(): ZenScrollSnapshot | null {
    const runtime = this.#runtime;
    if (!runtime) return null;
    return this.#historyExpanded
      ? captureZenScrollIntent(runtime)
      : captureZenScrollIntent(runtime, this.#scrollTops.get(runtime));
  }

  containsFocus(): boolean {
    return this.#rootEl.contains(this.#rootEl.ownerDocument.activeElement);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#pendingFrame) cancelScheduledAnimationFrame(this.#pendingFrame);
    this.#pendingFrame = null;
    this.#unsubscribeMain?.();
    this.#unsubscribeMain = null;
    this.#subscribeSide(null);
    this.#runtime = null;
    this.#popKeyScope();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#rootEl.remove();
    this.hostEl.removeClass(HOST_CLASS);
    this.hostEl.style.removeProperty(RESERVED_HEIGHT_PROPERTY);
  }

  #applyHistoryExpanded(): void {
    const expanded = this.#historyExpanded;
    // An empty conversation has no history to disclose; the remembered choice waits for messages.
    this.#disclosureEl.toggleClass('claudian-hidden', !this.#hasHistory);
    this.#historyEl.toggleClass('claudian-hidden', !expanded || !this.#hasHistory);
    this.#rootEl.toggleClass('claudian-zen--expanded', expanded);
    this.#disclosureEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    this.#disclosureEl.setAttribute(
      'aria-label',
      expanded ? t('chat.zen.hideHistory') : t('chat.zen.showHistory'),
    );
  }

  #scheduleRender(): void {
    if (this.#destroyed || this.#pendingFrame) return;
    this.#pendingFrame = scheduleAnimationFrame(
      () => this.#render(),
      this.#rootEl.ownerDocument.defaultView,
    );
  }

  #render(): void {
    if (this.#pendingFrame) cancelScheduledAnimationFrame(this.#pendingFrame);
    this.#pendingFrame = null;
    const runtime = this.#runtime;
    if (this.#destroyed || !runtime) return;

    const sideChat = runtime.controllers.sideChatController;
    const sideRuntime = sideChat.runtime;
    this.#subscribeSide(sideRuntime?.state ?? null);
    const isSide = sideChat.destination === 'side' && sideRuntime !== null;
    const selectedState = isSide ? sideRuntime.state : runtime.state;
    const otherState = isSide ? runtime.state : sideRuntime?.state ?? null;
    // An unresolved interaction on the other destination must not hide behind an idle line.
    const preview = formatActivityPreview(
      !selectedState.requiresAction && otherState?.requiresAction ? otherState : selectedState,
    );

    this.#previewEl.setText(preview.text);
    this.#renderPreviewIcon(preview.toolName ?? null);
    this.#rootEl.dataset.tone = preview.tone;
    this.#rootEl.dataset.destination = isSide ? 'side' : 'main';
    this.#destinationEl.toggleClass('claudian-hidden', !isSide);

    const hasHistory = runtime.state.messages.length > 0;
    if (hasHistory !== this.#hasHistory) {
      this.#hasHistory = hasHistory;
      this.#applyHistoryExpanded();
      if (hasHistory && this.#historyExpanded) {
        restoreZenScrollIntent(runtime, captureZenScrollIntent(runtime, this.#scrollTops.get(runtime)));
      }
    }

    if (preview.tone !== this.#lastTone) {
      if (preview.tone === 'action-required' || preview.tone === 'error') {
        this.#statusEl.setText(preview.text);
      } else if (this.#lastTone === 'action-required' || this.#lastTone === 'error') {
        this.#statusEl.setText('');
      }
      this.#lastTone = preview.tone;
    }
  }

  #renderPreviewIcon(toolName: string | null): void {
    this.#previewIconEl.toggleClass('claudian-hidden', toolName === null);
    if (toolName === null || toolName === this.#previewIconTool) return;
    this.#previewIconTool = toolName;
    this.#previewIconEl.empty();
    setToolIcon(this.#previewIconEl, toolName);
  }

  #subscribeSide(state: ChatState | null): void {
    if (state === this.#sideState) return;
    this.#unsubscribeSide?.();
    this.#sideState = state;
    this.#unsubscribeSide = state?.subscribeActivity(() => this.#scheduleRender()) ?? null;
  }

  #pushKeyScope(): void {
    if (this.#scopePushed || this.#destroyed || !this.options.keymap) return;
    this.options.keymap.pushScope(this.#keyScope);
    this.#scopePushed = true;
  }

  #popKeyScope(): void {
    if (!this.#scopePushed) return;
    this.#scopePushed = false;
    this.options.keymap?.popScope(this.#keyScope);
  }

  #observeReservedHeight(): void {
    const ResizeObserverConstructor = this.hostEl.ownerDocument.defaultView?.ResizeObserver;
    if (typeof ResizeObserverConstructor !== 'function') return;
    this.#resizeObserver = new ResizeObserverConstructor(() => {
      const height = Math.ceil(this.#rootEl.getBoundingClientRect().height);
      this.hostEl.style.setProperty(RESERVED_HEIGHT_PROPERTY, `${height}px`);
    });
    this.#resizeObserver.observe(this.#rootEl);
  }
}
