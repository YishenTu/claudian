import { setIcon } from 'obsidian';

import type { SideChatStatus } from '@/features/chat/side-chat/SideChatTypes';
import { t } from '@/i18n/i18n';

export interface SideChatPanelCallbacks {
  onExpand(): void;
  onCollapse(): void;
  onDiscard(): void;
}

const FULL_HEIGHT_HOST_CLASS = 'claudian-chat-panel--side-chat-full-height';

let panelSequence = 0;

/**
 * Side chat presentation above the shared composer. Expanded, the composer root
 * carries one side-colored outer border around the panel and the composer;
 * collapsed, a compact status chip provides access to the side conversation.
 */
export class SideChatPanel {
  readonly rootEl: HTMLElement;
  readonly messagesEl: HTMLElement;
  readonly promptsEl: HTMLElement;
  readonly #panelEl: HTMLElement;
  readonly #statusEl: HTMLElement;
  readonly #statusToggleEl: HTMLButtonElement;
  readonly #statusTextEl: HTMLElement;
  readonly #statusIconEl: HTMLElement;
  readonly #titleEl: HTMLElement;
  readonly #collapseEl: HTMLButtonElement;
  readonly #fullHeightEl: HTMLButtonElement;
  #collapsedHost: HTMLElement | null = null;
  #fullHeightHost: HTMLElement | null = null;
  #expanded = true;
  #fullHeight = false;

  constructor(
    private readonly hostEl: HTMLElement,
    private readonly callbacks: SideChatPanelCallbacks,
  ) {
    panelSequence += 1;
    const panelId = `claudian-side-chat-panel-${panelSequence}`;

    this.rootEl = hostEl.createDiv({ cls: 'claudian-side-chat' });

    this.#statusEl = this.rootEl.createDiv({ cls: 'claudian-side-chat-status' });
    this.#statusToggleEl = this.#statusEl.createEl('button', {
      attr: { 'aria-controls': panelId, 'aria-expanded': 'false', type: 'button' },
      cls: 'claudian-side-chat-status-toggle',
    });
    this.#statusIconEl = this.#statusToggleEl.createSpan({ cls: 'claudian-side-chat-status-icon' });
    this.#statusIconEl.setAttribute('aria-hidden', 'true');
    setIcon(this.#statusIconEl, 'chevron-right');
    this.#statusTextEl = this.#statusToggleEl.createSpan({ cls: 'claudian-side-chat-status-text' });
    this.#statusToggleEl.addEventListener('click', () => this.callbacks.onExpand());

    this.#panelEl = this.rootEl.createDiv({
      attr: { id: panelId },
      cls: 'claudian-side-chat-panel',
    });
    const headerEl = this.#panelEl.createDiv({ cls: 'claudian-side-chat-header' });
    this.#titleEl = headerEl.createEl('h3', {
      cls: 'claudian-side-chat-title',
      text: t('chat.sideChat.title'),
    });
    const actionsEl = headerEl.createDiv({ cls: 'claudian-side-chat-actions' });

    this.#fullHeightEl = actionsEl.createEl('button', {
      attr: {
        'aria-controls': panelId, 'aria-pressed': 'false', type: 'button',
        'aria-label': t('chat.sideChat.fullHeight'),
      },
      cls: 'claudian-side-chat-icon-button claudian-side-chat-full-height',
    });
    this.#fullHeightEl.addEventListener('click', () => this.#setFullHeight(!this.#fullHeight));

    this.#collapseEl = actionsEl.createEl('button', {
      attr: {
        'aria-controls': panelId, 'aria-expanded': 'true', type: 'button',
        'aria-label': t('chat.sideChat.collapse'),
      },
      cls: 'claudian-side-chat-icon-button',
    });
    setIcon(this.#collapseEl, 'minimize-2');
    this.#collapseEl.addEventListener('click', () => this.callbacks.onCollapse());

    const discardEl = actionsEl.createEl('button', {
      attr: {
        type: 'button', 'aria-label': t('chat.sideChat.discard'),
      },
      cls: 'claudian-side-chat-icon-button',
    });
    setIcon(discardEl, 'x');
    discardEl.addEventListener('click', () => this.callbacks.onDiscard());

    this.messagesEl = this.#panelEl.createDiv({ cls: 'claudian-side-chat-messages' });
    this.promptsEl = this.#panelEl.createDiv({ cls: 'claudian-side-chat-prompts' });

    setIcon(this.#fullHeightEl, 'unfold-vertical');
    this.setExpanded(true);
  }

  get isExpanded(): boolean {
    return this.#expanded;
  }

  /** The view supplies a chip slot above compact navigation for its active tab. */
  setCollapsedHost(host: HTMLElement | null): void {
    this.#collapsedHost = host;
    this.#updateLocation();
  }

  /** The view lends its chat panel while this composer is its active footer composer. */
  setFullHeightHost(host: HTMLElement | null): void {
    if (host === this.#fullHeightHost) return;
    this.#fullHeightHost?.removeClass(FULL_HEIGHT_HOST_CLASS);
    this.#fullHeightHost = host;
    this.#setFullHeight(this.#fullHeight);
  }

  setExpanded(expanded: boolean): void {
    const hadFocus = this.rootEl.contains(this.rootEl.ownerDocument.activeElement);
    this.#expanded = expanded;
    this.rootEl.toggleClass('claudian-side-chat--expanded', expanded);
    this.#panelEl.toggleClass('claudian-hidden', !expanded);
    this.#statusEl.toggleClass('claudian-hidden', expanded);
    this.#statusToggleEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    this.#collapseEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    this.#setFullHeight(this.#fullHeight);
    this.#updateLocation();
    if (hadFocus) this.focusToggle();
  }

  update(status: SideChatStatus, options: { title?: string | null; error?: string | null; queuedCount?: number }): void {
    const label = status === 'working' && options.queuedCount
      ? t('chat.sideChat.statusQueued', { count: options.queuedCount })
      : describeStatus(status, options.error);
    const title = options.title ?? t('chat.sideChat.title');
    this.#titleEl.setText(title);
    this.#titleEl.setAttribute('title', title);
    this.#statusTextEl.setText(title);
    this.#statusToggleEl.setAttribute('title', label ? `${title} · ${label}` : title);
    if (this.rootEl.getAttribute('data-side-chat-status') !== status) {
      setIcon(this.#statusIconEl, status === 'working' || status === 'preparing'
        ? 'loader-circle'
        : status === 'action-required' || status === 'error'
          ? 'circle-alert'
          : 'chevron-right');
    }
    this.rootEl.setAttribute('data-side-chat-status', status);
  }

  focusToggle(): void {
    (this.#expanded ? this.#collapseEl : this.#statusToggleEl).focus();
  }

  destroy(): void {
    this.setFullHeightHost(null);
    this.rootEl.remove();
  }

  /**
   * Full height gives the main transcript's space to the expanded panel; the destination is unchanged.
   * The choice survives collapse, but only an expanded panel applies it.
   */
  #setFullHeight(fullHeight: boolean): void {
    if (fullHeight !== this.#fullHeight) {
      this.#fullHeight = fullHeight;
      this.#fullHeightEl.setAttribute('aria-pressed', fullHeight ? 'true' : 'false');
      setIcon(this.#fullHeightEl, fullHeight ? 'fold-vertical' : 'unfold-vertical');
    }
    const applied = fullHeight && this.#expanded;
    this.rootEl.toggleClass('claudian-side-chat--full-height', applied);
    this.#fullHeightHost?.toggleClass(FULL_HEIGHT_HOST_CLASS, applied);
  }

  #updateLocation(): void {
    const parent = !this.#expanded && this.#collapsedHost ? this.#collapsedHost : this.hostEl;
    if (this.rootEl.parentElement !== parent) parent.insertBefore(this.rootEl, parent.firstChild);
  }
}

function describeStatus(status: SideChatStatus, error?: string | null): string {
  switch (status) {
    case 'preparing':
      return t('chat.sideChat.statusPreparing');
    case 'working':
      return t('chat.sideChat.statusWorking');
    case 'action-required':
      return t('chat.sideChat.statusActionRequired');
    case 'error':
      return error ?? t('chat.sideChat.statusError');
    case 'idle':
      return '';
  }
}
