import { type Keymap, Scope } from 'obsidian';

import type { ProviderId } from '@/core/providers/types';
import type { ZenModePosition } from '@/core/types';
import { setToolIcon } from '@/features/chat/rendering/tools/toolContentPrimitives';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '@/features/chat/utils/animationFrame';
import { formatActivityPreview, type ZenActivityTone } from '@/features/chat/zen/activityPreview';
import type { ZenModeSlots, ZenPresentationPort } from '@/features/chat/zen/types';
import { ZenComposerLayout } from '@/features/chat/zen/ZenComposerLayout';
import { ZenPanelDock } from '@/features/chat/zen/ZenPanelDock';
import { t } from '@/i18n/i18n';

export interface ZenModePanelOptions {
  readonly keymap: Pick<Keymap, 'pushScope' | 'popScope'> | null;
  readonly parentScope: Scope;
  readonly historyExpanded: boolean;
  onHistoryExpandedChange(expanded: boolean): void;
  readonly position: ZenModePosition | null;
  onPositionChange(position: ZenModePosition | null): void;
}

const HOST_CLASS = 'claudian-zen-host';
// Body-level surfaces that zen controls open; interacting with them is not leaving zen.
const OWNED_OVERLAY_SELECTOR = '.menu, .modal-container, .suggestion-container';

let panelSequence = 0;

/**
 * Compact presentation for one attached runtime: a state-driven activity line,
 * the moved transcript behind a disclosure, and the moved composer, which keeps
 * its own send and cancel keys, shows its model, effort and fast mode controls inline,
 * and keeps the context gauge in its info row below.
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
  // Inherit global commands without inheriting the active note's view hotkeys.
  readonly #keyScope: Scope;
  #scopePushed = false;
  #runtime: ZenPresentationPort | null = null;
  #unsubscribeMain: (() => void) | null = null;
  #pendingFrame: ScheduledAnimationFrame | null = null;
  #historyExpanded: boolean;
  #hasHistory = false;
  #lastTone: ZenActivityTone | null = null;
  readonly #composerLayout: ZenComposerLayout;
  readonly #dock: ZenPanelDock;
  #destroyed = false;

  constructor(
    private readonly hostEl: HTMLElement,
    private readonly options: ZenModePanelOptions,
  ) {
    this.#keyScope = new Scope(options.parentScope);
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
    this.#disclosureEl.addEventListener('click', () => this.toggleHistoryExpanded());

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
    // Under the composer, shown on hover or keyboard focus, so the chat controls keep their own clicks.
    const gripEl = this.#rootEl.createEl('button', {
      cls: 'claudian-zen-grip',
      attr: { type: 'button', tabindex: '-1', 'aria-label': t('chat.zen.move') },
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
    this.#dock = new ZenPanelDock({ hostEl, rootEl: this.#rootEl, gripEl, drawerEl, composerEl }, {
      position: options.position,
      onPositionChange: position => options.onPositionChange(position),
    });
  }

  get runtime(): ZenPresentationPort | null {
    return this.#runtime;
  }

  bind(runtime: ZenPresentationPort | null, providerId: ProviderId | null): void {
    if (this.#destroyed) return;
    this.#dock.refresh();
    if (providerId) this.#rootEl.dataset.provider = providerId;
    else delete this.#rootEl.dataset.provider;
    if (runtime === this.#runtime) {
      this.#scheduleRender();
      return;
    }
    this.#unsubscribeMain?.();
    this.#unsubscribeMain = null;
    this.#runtime = runtime;
    if (!runtime) return;

    this.#unsubscribeMain = runtime.subscribeActivity(() => this.#scheduleRender());
    if (this.#historyExpanded) runtime.restoreScroll();
    this.#render();
  }

  toggleHistoryExpanded(): void {
    this.setHistoryExpanded(!this.#historyExpanded);
  }

  setHistoryExpanded(expanded: boolean): void {
    if (this.#destroyed || expanded === this.#historyExpanded) return;
    this.#historyExpanded = expanded;
    this.#applyHistoryExpanded();
    if (expanded && this.#runtime) this.#runtime.restoreScroll();
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
    this.#composerLayout.destroy();
    this.#dock.destroy();
    this.hostEl.ownerDocument.removeEventListener('pointerdown', this.#handleOutsidePointerDown, true);
    this.#rootEl.remove();
    this.hostEl.removeClass(HOST_CLASS);
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
    if (!expanded && this.#hasHistory && this.#historyEl.contains(this.hostEl.ownerDocument.activeElement)) {
      this.#disclosureEl.focus({ preventScroll: true });
    }
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
      if (hasHistory && this.#historyExpanded) runtime.restoreScroll();
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
}
