import { setIcon } from 'obsidian';

import type { ProviderIconSvg } from '@/core/providers/types';
import type { ConversationMeta } from '@/core/types';
import { getLinkedContentTitle, isLegacyProvisionalLinkedContent } from '@/features/chat/session-manager/SessionListOrganizer';
import { createProviderIconSvg } from '@/shared/icons';

/** Presentation inputs the popover reads from the current list render. */
export interface SessionMetadataOptions {
  language?: string;
  contentExists?: (contentPath: string) => boolean;
  contentIsNote?: (contentPath: string) => boolean;
  getProviderIcon?: (conversation: ConversationMeta) => ProviderIconSvg | null | undefined;
  getModelLabel?: (conversation: ConversationMeta) => string;
  /** Closes the popover when the render that attached it is superseded. */
  signal?: AbortSignal;
}

interface SessionMetadataView {
  el: HTMLElement;
  linkedContent: HTMLElement;
  provider: HTMLElement;
  created: HTMLElement;
  lastActive: HTMLElement;
  providerIcon: SVGElement | null;
  providerIconKey: string;
}

export function formatSessionCreatedDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatSessionLastActive(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * The single hover/focus tooltip describing a session row. One reusable element per
 * document is moved between rows; its rows and icon are updated in place.
 */
export class SessionMetadataPopover {
  private cleanup: (() => void) | null = null;
  private closeTimer: number | null = null;
  private popoverEl: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private sequence = 0;
  private view: SessionMetadataView | null = null;

  dispose(): void {
    this.close();
    this.view = null;
  }

  /** Shows the session's metadata while the row is hovered or its focus target is focused. */
  attach(
    item: HTMLElement,
    focusTarget: HTMLElement,
    conversation: ConversationMeta,
    options: SessionMetadataOptions,
  ): void {
    item.addEventListener('mouseenter', () => {
      this.#show(item, focusTarget, conversation, options);
    });
    item.addEventListener('mouseleave', () => {
      this.#scheduleClose(item);
    });
    focusTarget.addEventListener('focusin', () => {
      this.#show(item, focusTarget, conversation, options);
    });
    focusTarget.addEventListener('focusout', () => {
      queueMicrotask(() => {
        const activeElement = item.ownerDocument.activeElement;
        if (activeElement && focusTarget.contains(activeElement)) return;
        if (typeof item.matches === 'function' && item.matches(':hover')) return;
        if (this.target === item) {
          this.#scheduleClose(item);
        }
      });
    });
    focusTarget.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.target !== item) return;
      event.stopPropagation();
      this.close();
    });
  }

  #show(
    item: HTMLElement,
    descriptionTarget: HTMLElement,
    conversation: ConversationMeta,
    options: SessionMetadataOptions,
  ): void {
    if (this.popoverEl && this.target === item) {
      this.#cancelClose();
      return;
    }
    // Measure the anchor before removing/inserting popover DOM.
    const targetRect = item.getBoundingClientRect();
    this.close();

    const document = item.ownerDocument;
    if (!document.body) return;
    const view = this.#getView(document);
    const hoverEl = view.el;
    this.popoverEl = hoverEl;
    this.target = item;

    const popoverId = `claudian-session-metadata-${++this.sequence}`;
    hoverEl.setAttribute('id', popoverId);
    descriptionTarget.setAttribute('aria-describedby', popoverId);

    const language = options.language ?? 'en';
    const linkedContentPath = conversation.linkedContentPath;
    const hasLinkedContent = !!linkedContentPath
      && !isLegacyProvisionalLinkedContent(linkedContentPath, {
        contentExists: options.contentExists,
        contentIsNote: options.contentIsNote,
        language,
      });
    view.linkedContent.parentElement!.classList.toggle('claudian-hidden', !hasLinkedContent);
    view.linkedContent.textContent = hasLinkedContent ? getLinkedContentTitle(linkedContentPath) : '';
    view.linkedContent.title = hasLinkedContent ? linkedContentPath : '';
    view.provider.textContent = options.getModelLabel?.(conversation) ?? conversation.selectedModel ?? '';
    view.created.textContent = formatSessionCreatedDate(conversation.createdAt);
    view.lastActive.textContent = formatSessionLastActive(conversation.lastActivityAt);

    const icon = options.getProviderIcon?.(conversation);
    const iconKey = JSON.stringify([conversation.providerId, icon ?? null]);
    if (view.providerIconKey !== iconKey) {
      view.providerIcon?.remove();
      const row = view.provider.parentElement!;
      row.classList.toggle('claudian-session-metadata-row--provider-no-icon', !icon);
      view.providerIcon = icon ? createProviderIconSvg(icon, {
        className: 'claudian-session-metadata-provider-icon', dataProvider: conversation.providerId,
        height: 14, width: 14, parent: row,
      }) : null;
      if (view.providerIcon) row.prepend(view.providerIcon);
      view.providerIconKey = iconKey;
    }
    hoverEl.removeClass('claudian-hidden');
    document.body.appendChild(hoverEl);
    this.#position(targetRect, hoverEl);
    const cancelClose = (): void => this.#cancelClose();
    const scheduleClose = (): void => this.#scheduleClose(item);
    const closeForViewportChange = (): void => {
      if (this.popoverEl === hoverEl) this.close();
    };
    const closeForExternalScroll = (event: Event): void => {
      if (event.composedPath().includes(hoverEl)) return;
      closeForViewportChange();
    };
    hoverEl.addEventListener('mouseenter', cancelClose);
    hoverEl.addEventListener('mouseleave', scheduleClose);
    document.addEventListener('scroll', closeForExternalScroll, true);
    document.defaultView?.addEventListener('resize', closeForViewportChange);

    const signal = options.signal;
    const closeOnAbort = (): void => {
      if (this.popoverEl === hoverEl) {
        this.close();
      }
    };
    signal?.addEventListener('abort', closeOnAbort, { once: true });
    this.cleanup = () => {
      hoverEl.removeEventListener('mouseenter', cancelClose);
      hoverEl.removeEventListener('mouseleave', scheduleClose);
      document.removeEventListener('scroll', closeForExternalScroll, true);
      document.defaultView?.removeEventListener('resize', closeForViewportChange);
      signal?.removeEventListener('abort', closeOnAbort);
      if (descriptionTarget.getAttribute('aria-describedby') === popoverId) {
        descriptionTarget.removeAttribute('aria-describedby');
      }
    };
  }

  #position(targetRect: DOMRect, popover: HTMLElement): void {
    const document = popover.ownerDocument;
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = document.defaultView?.innerWidth
      ?? document.documentElement?.clientWidth
      ?? 1024;
    const viewportHeight = document.defaultView?.innerHeight
      ?? document.documentElement?.clientHeight
      ?? 768;
    const gap = 8;
    const viewportMargin = 8;

    let left = targetRect.right + gap;
    if (left + popoverRect.width > viewportWidth - viewportMargin) {
      left = targetRect.left - popoverRect.width - gap;
    }
    left = Math.min(
      Math.max(viewportMargin, left),
      Math.max(viewportMargin, viewportWidth - popoverRect.width - viewportMargin),
    );

    const top = Math.min(
      Math.max(viewportMargin, targetRect.top),
      Math.max(viewportMargin, viewportHeight - popoverRect.height - viewportMargin),
    );
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  #scheduleClose(target: HTMLElement): void {
    if (this.target !== target) return;
    this.#cancelClose();
    const window = target.ownerDocument.defaultView;
    if (!window) {
      this.close();
      return;
    }
    this.closeTimer = window.setTimeout(() => {
      if (this.target === target) {
        this.close();
      }
    }, 120);
  }

  #cancelClose(): void {
    if (this.closeTimer === null) return;
    this.target?.ownerDocument.defaultView?.clearTimeout(
      this.closeTimer,
    );
    this.closeTimer = null;
  }

  #renderRow(
    parent: HTMLElement,
    icon: string,
    label: string | null,
    value: string,
    options: { className?: string; title?: string } = {},
  ): HTMLElement {
    const row = parent.createDiv({
      cls: [
        'claudian-session-metadata-row',
        label ? '' : 'claudian-session-metadata-row--unlabeled',
      ].filter(Boolean).join(' '),
    });
    const iconEl = row.createSpan({ cls: 'claudian-session-metadata-icon' });
    setIcon(iconEl, icon);
    if (label) {
      row.createSpan({ cls: 'claudian-session-metadata-label', text: label });
    }
    const valueEl = row.createSpan({
      cls: [
        'claudian-session-metadata-value',
        options.className ?? '',
      ].filter(Boolean).join(' '),
      text: value,
    });
    if (options.title) valueEl.setAttribute('title', options.title);
    return valueEl;
  }

  #getView(document: Document) {
    if (this.view?.el.ownerDocument === document) return this.view;
    const el = document.body.createDiv({ cls: 'claudian-session-metadata-popover' });
    el.setAttribute('role', 'tooltip');
    const linkedContent = this.#renderRow(el, 'file-text', null, '', {
      className: 'claudian-session-metadata-value--content',
    });
    const providerRow = el.createDiv({ cls: 'claudian-session-metadata-row claudian-session-metadata-row--provider' });
    const provider = providerRow.createSpan({ cls: 'claudian-session-metadata-value claudian-session-metadata-value--provider' });
    this.view = {
      el, linkedContent, provider,
      created: this.#renderRow(el, 'calendar-days', 'Created', ''),
      lastActive: this.#renderRow(el, 'clock-3', 'Last active', ''),
      providerIcon: null, providerIconKey: '',
    };
    return this.view;
  }

  close(): void {
    this.#cancelClose();
    const popover = this.popoverEl;
    this.cleanup?.();
    this.cleanup = null;
    this.popoverEl = null;
    this.target = null;
    popover?.addClass('claudian-hidden');
    popover?.remove();
  }
}
