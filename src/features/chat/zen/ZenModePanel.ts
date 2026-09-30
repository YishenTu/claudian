import { type Keymap, Scope } from 'obsidian';

import { t } from '../../../i18n/i18n';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';
import { setToolIcon } from '../rendering/ToolCallRenderer';
import type { AssembledTabRuntime } from '../tabs/types';
import { formatActivityPreview, type ZenActivityTone } from './activityPreview';
import type { ZenModeSlots } from './types';
import { ZenComposerLayout } from './ZenComposerLayout';

/** Reading intent captured before the transcript is relocated. */
export interface ZenScrollSnapshot {
  readonly top: number;
  readonly follow: boolean;
}

export interface ZenModePanelOptions {
  readonly keymap: Pick<Keymap, 'pushScope' | 'popScope'> | null;
  readonly historyExpanded: boolean;
  onHistoryExpandedChange(expanded: boolean): void;
}

const HOST_CLASS = 'claudian-zen-host';
// Body-level surfaces that zen controls open; interacting with them is not leaving zen.
const OWNED_OVERLAY_SELECTOR = '.menu, .modal-container, .suggestion-container';
const RESERVED_HEIGHT_PROPERTY = '--claudian-zen-reserved-height';

let panelSequence = 0;

/** Reads the last visible position; a hidden transcript's own offset reads zero. */
export function captureZenScrollIntent(runtime: AssembledTabRuntime): ZenScrollSnapshot {
  return { top: runtime.state.readingScrollTop, follow: runtime.state.autoScrollEnabled };
}

/** Follows new output when the reader was following, otherwise keeps their position. */
export function restoreZenScrollIntent(
  runtime: AssembledTabRuntime,
  snapshot: ZenScrollSnapshot = captureZenScrollIntent(runtime),
): void {
  const messagesEl = runtime.dom.messagesEl;
  messagesEl.scrollTop = snapshot.follow ? messagesEl.scrollHeight : snapshot.top;
  runtime.state.readingScrollTop = snapshot.top;
  // Relocation can emit geometry-only scroll events; they must not replace the captured intent.
  if (runtime.state.autoScrollEnabled !== snapshot.follow) runtime.state.autoScrollEnabled = snapshot.follow;
}

/**
 * Compact presentation for one attached runtime: a state-driven activity line,
 * the moved transcript behind a disclosure, and the moved composer, which keeps
 * its own send and cancel keys and shows its model, effort, fast mode and context controls inline.
 * It holds presentation state only; chat owners keep drafts, queues and turns.
 */
export class ZenModePanel {
  readonly slots: ZenModeSlots;
  readonly #rootEl: HTMLElement;
  readonly #drawerEl: HTMLElement;
  readonly #historyEl: HTMLElement;
  readonly #disclosureEl: HTMLButtonElement;
  readonly #previewEl: HTMLElement;
  readonly #previewIconEl: HTMLElement;
  #previewIconTool: string | null = null;
  readonly #statusEl: HTMLElement;
  // A parentless scope keeps the active note's hotkeys away from zen input while it has focus.
  readonly #keyScope = new Scope();
  #scopePushed = false;
  #runtime: AssembledTabRuntime | null = null;
  #unsubscribeMain: (() => void) | null = null;
  #pendingFrame: ScheduledAnimationFrame | null = null;
  #historyExpanded: boolean;
  #hasHistory = false;
  #lastTone: ZenActivityTone | null = null;
  #resizeObserver: ResizeObserver | null = null;
  readonly #composerLayout: ZenComposerLayout;
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
    this.#drawerEl = drawerEl;
    this.#historyEl = drawerEl.createDiv({
      cls: 'claudian-zen-history', attr: { id: historyId, tabindex: '-1' },
    });

    const previewId = `claudian-zen-preview-${panelSequence}`;
    const barEl = drawerEl.createDiv({ cls: 'claudian-zen-bar' });
    // The whole preview line opens the transcript; its label names the action, the preview describes it.
    // Expanded, the line steps aside; a click or focus move outside zen collapses it again.
    this.#disclosureEl = barEl.createEl('button', {
      cls: 'claudian-zen-disclosure',
      attr: {
        type: 'button',
        'aria-controls': historyId,
        'aria-describedby': previewId,
        'aria-label': t('chat.zen.showHistory'),
      },
    });
    this.#disclosureEl.addEventListener('click', () => this.setHistoryExpanded(!this.#historyExpanded));

    this.#previewIconEl = this.#disclosureEl.createSpan({
      cls: 'claudian-zen-preview-icon claudian-hidden',
      attr: { 'aria-hidden': 'true' },
    });
    this.#previewEl = this.#disclosureEl.createSpan({ cls: 'claudian-zen-preview', attr: { id: previewId } });

    const composerEl = this.#rootEl.createDiv({ cls: 'claudian-zen-composer' });
    // Shares the sidebar slot class so it collapses while empty.
    const sideChatChipEl = this.#rootEl.createDiv({
      cls: 'claudian-zen-side-chat-chip-slot claudian-side-chat-chip-slot',
    });

    this.#statusEl = this.#rootEl.createDiv({ cls: 'claudian-zen-status', attr: { role: 'status' } });

    this.#rootEl.addEventListener('focusin', () => this.#pushKeyScope());
    this.#rootEl.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null;
      if (!next || !this.#rootEl.contains(next)) this.#popKeyScope();
      // Leaving the window reports no target and keeps the transcript open.
      if (next) this.#collapseOnLeave(next);
    });

    hostEl.ownerDocument.addEventListener('pointerdown', this.#handleOutsidePointerDown, true);

    this.slots = { historyEl: this.#historyEl, composerEl, sideChatChipEl };
    this.#composerLayout = new ZenComposerLayout(composerEl);
    this.#applyHistoryExpanded();
    this.#observeReservedHeight();
  }

  get runtime(): AssembledTabRuntime | null {
    return this.#runtime;
  }

  bind(runtime: AssembledTabRuntime | null): void {
    if (this.#destroyed) return;
    if (runtime === this.#runtime) {
      this.#scheduleRender();
      return;
    }
    this.#unsubscribeMain?.();
    this.#unsubscribeMain = null;
    this.#runtime = runtime;
    if (!runtime) return;

    this.#unsubscribeMain = runtime.state.subscribeActivity(() => this.#scheduleRender());
    if (runtime.providerId) this.#rootEl.dataset.provider = runtime.providerId;
    else delete this.#rootEl.dataset.provider;
    if (this.#historyExpanded) restoreZenScrollIntent(runtime);
    this.#render();
  }

  setHistoryExpanded(expanded: boolean): void {
    if (this.#destroyed || expanded === this.#historyExpanded) return;
    this.#historyExpanded = expanded;
    this.#applyHistoryExpanded();
    if (expanded && this.#runtime) restoreZenScrollIntent(this.#runtime);
    this.options.onHistoryExpandedChange(expanded);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#pendingFrame) cancelScheduledAnimationFrame(this.#pendingFrame);
    this.#pendingFrame = null;
    this.#unsubscribeMain?.();
    this.#unsubscribeMain = null;
    this.#runtime = null;
    this.#popKeyScope();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#composerLayout.destroy();
    this.hostEl.ownerDocument.removeEventListener('pointerdown', this.#handleOutsidePointerDown, true);
    this.#rootEl.remove();
    this.hostEl.removeClass(HOST_CLASS);
    this.hostEl.style.removeProperty(RESERVED_HEIGHT_PROPERTY);
  }

  #applyHistoryExpanded(): void {
    const expanded = this.#historyExpanded;
    // A new conversation shows only the composer; the remembered choice waits for messages.
    this.#drawerEl.toggleClass('claudian-hidden', !this.#hasHistory);
    this.#historyEl.toggleClass('claudian-hidden', !expanded || !this.#hasHistory);
    // Transfer focus before CSS hides the disclosure, keeping the zen keyboard scope active.
    if (expanded && this.#hasHistory && this.hostEl.ownerDocument.activeElement === this.#disclosureEl) {
      this.#historyEl.focus({ preventScroll: true });
    }
    this.#rootEl.toggleClass('claudian-zen--expanded', expanded);
    this.#disclosureEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  readonly #handleOutsidePointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target) this.#collapseOnLeave(target);
  };

  /** Collapses visible history when interaction moves outside zen and the overlays its controls open. */
  #collapseOnLeave(node: Node): void {
    if (!this.#historyExpanded || !this.#hasHistory || this.#rootEl.contains(node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    if (element?.closest(OWNED_OVERLAY_SELECTOR)) return;
    this.setHistoryExpanded(false);
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

    // The drawer always follows the main chat; a side chat reports in its own panel.
    const preview = formatActivityPreview(runtime.state);

    this.#previewEl.setText(preview.text);
    this.#renderPreviewIcon(preview.toolName ?? null);
    this.#rootEl.dataset.tone = preview.tone;

    const hasHistory = runtime.state.messages.length > 0;
    if (hasHistory !== this.#hasHistory) {
      this.#hasHistory = hasHistory;
      this.#applyHistoryExpanded();
      if (hasHistory && this.#historyExpanded) restoreZenScrollIntent(runtime);
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
