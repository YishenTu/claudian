import { setIcon } from 'obsidian';

import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';
import { formatConversationDirectoryTitle } from '../utils/conversationDirectoryTitle';

type ConversationOutlineKind = 'prompt' | 'heading';
type ConversationOutlineLevel = 1 | 2 | 3;

interface ConversationOutlineEntry {
  targetEl: HTMLElement;
  messageEl: HTMLElement;
  title: string;
  excerpt: string;
  badge: string;
  kind: ConversationOutlineKind;
  level: ConversationOutlineLevel;
  headingIndex?: number;
  headingOccurrence?: number;
}

const OUTLINE_EXCERPT_LENGTH = 140;
const OUTLINE_REFRESH_DELAY_MS = 80;
const OUTLINE_COMPACT_MAX_GAP_PX = 12;
const OUTLINE_COMPACT_MAX_SPAN_PX = 216;
let nextOutlinePreviewId = 0;
let nextDirectoryPopoverId = 0;

function normalizeOutlineText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateOutlineText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/**
 * Floating sidebar for navigating chat history.
 * Provides quick access to top/bottom and previous/next user messages.
 */
export class NavigationSidebar {
  private container: HTMLElement;
  private topBtn: HTMLElement;
  private prevBtn: HTMLElement;
  private tocBtn: HTMLElement;
  private nextBtn: HTMLElement;
  private bottomBtn: HTMLElement;
  private outlineTrack: HTMLElement;
  private outlineEntries: ConversationOutlineEntry[] = [];
  private outlineEntriesByMessage = new Map<HTMLElement, ConversationOutlineEntry[]>();
  private outlineMarkers: HTMLElement[] = [];
  private activeOutlineIndex: number | null = null;
  private lastOutlineTrackHeight = -1;
  private outlinePreview: HTMLElement | null = null;
  private outlinePreviewTrigger: HTMLElement | null = null;
  private tocPopover: HTMLElement | null = null;
  private readonly directoryPopoverId = `claudian-directory-${++nextDirectoryPopoverId}`;
  private scrollHandler: () => void = () => {};
  private outsideClickHandler: ((event: MouseEvent) => void) | null = null;
  private mutationObserver: MutationObserver | null = null;
  private pendingVisibilityFrame: ScheduledAnimationFrame | null = null;
  private pendingOutlineRefresh: { id: number; ownerWindow: Window } | null = null;
  private pendingOutlineMessages = new Set<HTMLElement>();
  private pendingFullOutlineRefresh = false;
  private isVisible: boolean | null = null;

  constructor(
    private parentEl: HTMLElement,
    private messagesEl: HTMLElement
  ) {
    this.container = this.parentEl.createDiv({ cls: 'claudian-nav-sidebar' });

    // Create buttons
    this.topBtn = this.createButton('claudian-nav-btn-top', 'chevrons-up', 'Scroll to top');
    this.prevBtn = this.createButton('claudian-nav-btn-prev', 'chevron-up', 'Previous message');
    const outlineSlot = this.container.createDiv({ cls: 'claudian-nav-outline-slot' });
    this.tocBtn = this.createButton(
      'claudian-nav-btn-toc',
      'list-tree',
      'Conversation directory',
      outlineSlot,
    );
    this.outlineTrack = outlineSlot.createDiv({ cls: 'claudian-nav-outline-track' });
    this.outlineTrack.setAttribute('role', 'navigation');
    this.outlineTrack.setAttribute('aria-label', 'Conversation outline');
    this.nextBtn = this.createButton('claudian-nav-btn-next', 'chevron-down', 'Next message');
    this.bottomBtn = this.createButton('claudian-nav-btn-bottom', 'chevrons-down', 'Scroll to bottom');

    this.setupEventListeners();
    this.refreshOutline();
    this.applyVisibility();
  }

  private createButton(
    cls: string,
    icon: string,
    label: string,
    parentEl: HTMLElement = this.container,
  ): HTMLElement {
    const btn = parentEl.createEl('button', {
      cls: `claudian-nav-btn ${cls}`,
      attr: {
        type: 'button',
        'aria-label': label,
      },
    });
    setIcon(btn, icon);
    return btn;
  }

  private setupEventListeners(): void {
    // Scroll handling to toggle visibility
    this.scrollHandler = () => this.updateVisibility();
    this.messagesEl.addEventListener('scroll', this.scrollHandler, { passive: true });

    // Button clicks
    this.topBtn.addEventListener('click', () => {
      this.messagesEl.scrollTo({ top: 0, behavior: this.getScrollBehavior() });
    });

    this.bottomBtn.addEventListener('click', () => {
      this.messagesEl.scrollTo({
        top: this.messagesEl.scrollHeight,
        behavior: this.getScrollBehavior(),
      });
    });

    this.prevBtn.addEventListener('click', () => this.scrollToMessage('prev'));
    this.nextBtn.addEventListener('click', () => this.scrollToMessage('next'));
    this.tocBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleDirectory();
    });
    this.tocBtn.setAttribute('aria-haspopup', 'dialog');
    this.tocBtn.setAttribute('aria-expanded', 'false');
    this.tocBtn.setAttribute('aria-controls', this.directoryPopoverId);
    this.tocBtn.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !this.tocPopover) return;
      event.preventDefault();
      event.stopPropagation();
      this.closeDirectory(true);
    });

    this.outsideClickHandler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const containerContainsTarget = typeof this.container.contains === 'function'
        && this.container.contains(target);
      const popoverContainsTarget = typeof this.tocPopover?.contains === 'function'
        && this.tocPopover.contains(target);
      if (!containerContainsTarget && !popoverContainsTarget) {
        this.closeDirectory();
      }
    };
    this.parentEl.ownerDocument?.addEventListener?.('click', this.outsideClickHandler);

    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver((mutations) => {
        this.updateVisibility();
        const outlineMutations = mutations.filter(mutation => this.mutationAffectsOutline(mutation));
        if (outlineMutations.length > 0) {
          this.scheduleOutlineRefresh(outlineMutations);
        }
      });
      this.mutationObserver.observe(this.messagesEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-toc-title'],
        characterData: true,
      });
    }
  }

  /**
   * Updates visibility of the sidebar based on scroll state.
   * Visible if content overflows.
   */
  updateVisibility(): void {
    if (this.pendingVisibilityFrame !== null) return;
    this.pendingVisibilityFrame = scheduleAnimationFrame(() => {
      this.pendingVisibilityFrame = null;
      this.applyVisibility();
      this.applyActiveOutline();
    }, this.messagesEl.ownerDocument.defaultView ?? null);
  }

  private applyVisibility(): void {
    const { scrollHeight, clientHeight } = this.messagesEl;
    const isScrollable = scrollHeight > clientHeight + 50; // Small buffer
    this.tocBtn.classList.remove('claudian-hidden');
    if (this.isVisible === isScrollable) return;
    this.isVisible = isScrollable;
    this.container.classList.toggle('visible', isScrollable);
  }

  private scheduleOutlineRefresh(mutations: MutationRecord[]): void {
    this.queueOutlineMutations(mutations);
    if (this.pendingOutlineRefresh !== null) return;
    const ownerWindow = this.messagesEl.ownerDocument.defaultView;
    if (!ownerWindow) {
      const dirtyMessages = this.pendingFullOutlineRefresh
        ? null
        : new Set(this.pendingOutlineMessages);
      this.pendingFullOutlineRefresh = false;
      this.pendingOutlineMessages.clear();
      this.refreshOutline(dirtyMessages);
      return;
    }
    const id = ownerWindow.setTimeout(() => {
      this.pendingOutlineRefresh = null;
      const dirtyMessages = this.pendingFullOutlineRefresh
        ? null
        : new Set(this.pendingOutlineMessages);
      this.pendingFullOutlineRefresh = false;
      this.pendingOutlineMessages.clear();
      this.refreshOutline(dirtyMessages);
    }, OUTLINE_REFRESH_DELAY_MS);
    this.pendingOutlineRefresh = { id, ownerWindow };
  }

  private collectMessageOutlineEntries(messageEl: HTMLElement): ConversationOutlineEntry[] {
    const entries: ConversationOutlineEntry[] = [];
    if (this.isUserMessageElement(messageEl)) {
      const title = this.getDirectoryTitle(messageEl);
      if (!title) return entries;
      entries.push({
        targetEl: messageEl,
        messageEl,
        title,
        excerpt: this.getOutlineExcerpt(messageEl, title),
        badge: 'Q',
        kind: 'prompt',
        level: 1,
      });
      return entries;
    }

    let headingIndex = 0;
    const headingOccurrences = new Map<string, number>();
    for (const textBlockEl of messageEl.querySelectorAll<HTMLElement>('.claudian-text-block')) {
      for (const headingEl of textBlockEl.querySelectorAll<HTMLElement>('h1, h2, h3')) {
        const level = this.getHeadingLevel(headingEl);
        const title = truncateOutlineText(
          normalizeOutlineText(headingEl.textContent ?? ''),
          80,
        );
        if (!level || !title) continue;
        const occurrenceKey = `${level}:${title}`;
        const headingOccurrence = headingOccurrences.get(occurrenceKey) ?? 0;
        headingOccurrences.set(occurrenceKey, headingOccurrence + 1);
        entries.push({
          targetEl: headingEl,
          messageEl,
          title,
          excerpt: this.getHeadingExcerpt(headingEl),
          badge: `H${level}`,
          kind: 'heading',
          level,
          headingIndex,
          headingOccurrence,
        });
        headingIndex += 1;
      }
    }

    return entries;
  }

  private collectOutlineEntries(
    dirtyMessages: Set<HTMLElement> | null = null,
  ): ConversationOutlineEntry[] {
    const messageEls = Array.from(this.messagesEl.querySelectorAll<HTMLElement>(
      '.claudian-message-user, .claudian-message-assistant, [data-role="user"], [data-role="assistant"]',
    ));
    const currentMessages = new Set(messageEls);
    for (const cachedMessage of this.outlineEntriesByMessage.keys()) {
      if (!currentMessages.has(cachedMessage)) this.outlineEntriesByMessage.delete(cachedMessage);
    }

    const entries: ConversationOutlineEntry[] = [];
    for (const messageEl of messageEls) {
      if (
        dirtyMessages === null
        || dirtyMessages.has(messageEl)
        || !this.outlineEntriesByMessage.has(messageEl)
      ) {
        this.outlineEntriesByMessage.set(
          messageEl,
          this.collectMessageOutlineEntries(messageEl),
        );
      }
      entries.push(...(this.outlineEntriesByMessage.get(messageEl) ?? []));
    }
    return entries;
  }

  private hasSameOutlineStructure(entries: ConversationOutlineEntry[]): boolean {
    return entries.length === this.outlineEntries.length
      && entries.every((entry, index) => {
        const current = this.outlineEntries[index];
        return entry.kind === current.kind
          && entry.level === current.level
          && entry.badge === current.badge
          && entry.title === current.title;
      });
  }

  private getDirectoryEntries(): ConversationOutlineEntry[] {
    return this.collectOutlineEntries(null);
  }

  private getDirectoryTitle(el: HTMLElement): string {
    const explicitTitle = (el.getAttribute('data-toc-title') ?? '').trim();
    if (explicitTitle) return explicitTitle;

    const contentEl = el.querySelector<HTMLElement>('.claudian-message-content');
    return formatConversationDirectoryTitle(contentEl?.textContent ?? el.textContent ?? '');
  }

  private getOutlineExcerpt(sourceEl: HTMLElement, title: string): string {
    const contentEl = sourceEl.classList.contains('claudian-text-block')
      ? sourceEl
      : sourceEl.querySelector<HTMLElement>('.claudian-message-content');
    const content = normalizeOutlineText(contentEl?.textContent ?? sourceEl.textContent ?? '');
    if (!content) return '';

    const normalizedTitle = normalizeOutlineText(title);
    const titleIndex = content.toLocaleLowerCase().indexOf(normalizedTitle.toLocaleLowerCase());
    const remainder = titleIndex >= 0
      ? content.slice(titleIndex + normalizedTitle.length).trim()
      : content;
    return truncateOutlineText(remainder, OUTLINE_EXCERPT_LENGTH);
  }

  private getHeadingExcerpt(headingEl: HTMLElement): string {
    const sectionParts: string[] = [];
    let sibling = headingEl.nextElementSibling as HTMLElement | null;
    while (sibling) {
      if (this.getHeadingLevel(sibling)) break;
      const text = normalizeOutlineText(sibling.textContent ?? '');
      if (text) sectionParts.push(text);
      sibling = sibling.nextElementSibling as HTMLElement | null;
    }
    return truncateOutlineText(sectionParts.join(' '), OUTLINE_EXCERPT_LENGTH);
  }

  private getMessageHeadingElements(messageEl: HTMLElement): HTMLElement[] {
    const headings: HTMLElement[] = [];
    for (const textBlockEl of messageEl.querySelectorAll<HTMLElement>('.claudian-text-block')) {
      for (const headingEl of textBlockEl.querySelectorAll<HTMLElement>('h1, h2, h3')) {
        if (this.getHeadingLevel(headingEl) && normalizeOutlineText(headingEl.textContent ?? '')) {
          headings.push(headingEl);
        }
      }
    }
    return headings;
  }

  private resolveEntryTarget(entry: ConversationOutlineEntry): HTMLElement {
    if (this.messagesEl.contains(entry.targetEl)) return entry.targetEl;

    if (entry.kind === 'heading' && this.messagesEl.contains(entry.messageEl)) {
      const headings = this.getMessageHeadingElements(entry.messageEl);
      const matchingHeadings = headings.filter(headingEl => {
        const level = this.getHeadingLevel(headingEl);
        const title = truncateOutlineText(
          normalizeOutlineText(headingEl.textContent ?? ''),
          80,
        );
        return level === entry.level && title === entry.title;
      });
      const resolvedHeading = matchingHeadings[entry.headingOccurrence ?? 0]
        ?? headings[entry.headingIndex ?? -1];
      if (resolvedHeading) {
        entry.targetEl = resolvedHeading;
        entry.excerpt = this.getHeadingExcerpt(resolvedHeading);
        return resolvedHeading;
      }
    }

    return this.messagesEl.contains(entry.messageEl) ? entry.messageEl : this.messagesEl;
  }

  private getHeadingLevel(el: HTMLElement): ConversationOutlineLevel | null {
    const match = /^H([1-3])$/.exec(el.tagName.toUpperCase());
    if (!match) return null;
    return Number(match[1]) as ConversationOutlineLevel;
  }

  private isUserMessageElement(el: HTMLElement): boolean {
    return el.classList.contains('claudian-message-user')
      || el.getAttribute('data-role') === 'user';
  }

  private isOutlineMessageElement(node: Node | null): node is HTMLElement {
    if (!node) return false;
    const candidate = node as {
      classList?: { contains?: (className: string) => boolean };
      getAttribute?: (name: string) => string | null;
    };
    return candidate.classList?.contains?.('claudian-message-user') === true
      || candidate.classList?.contains?.('claudian-message-assistant') === true
      || candidate.getAttribute?.('data-role') === 'user'
      || candidate.getAttribute?.('data-role') === 'assistant';
  }

  private nodeContainsOutlineMessage(node: Node): boolean {
    if (this.isOutlineMessageElement(node)) return true;
    const candidate = node as { querySelector?: (selector: string) => Element | null };
    return typeof candidate.querySelector === 'function'
      && candidate.querySelector(
        '.claudian-message-user, .claudian-message-assistant, [data-role="user"], [data-role="assistant"]',
      ) !== null;
  }

  private findContainingOutlineMessage(node: Node | null): HTMLElement | null {
    let current = node;
    while (current && current !== this.messagesEl) {
      if (this.isOutlineMessageElement(current)) return current;
      current = current.parentNode;
    }
    return null;
  }

  private queueOutlineMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      if (this.pendingFullOutlineRefresh) return;
      if (mutation.type === 'childList') {
        const changedNodes = [
          ...Array.from(mutation.addedNodes),
          ...Array.from(mutation.removedNodes),
        ];
        if (changedNodes.some(node => this.nodeContainsOutlineMessage(node))) {
          this.pendingFullOutlineRefresh = true;
          this.pendingOutlineMessages.clear();
          continue;
        }
      }

      const messageEl = this.findContainingOutlineMessage(mutation.target);
      if (messageEl) {
        this.pendingOutlineMessages.add(messageEl);
      } else {
        this.pendingFullOutlineRefresh = true;
        this.pendingOutlineMessages.clear();
      }
    }
  }

  private isOutlineHeadingElement(node: Node | null): node is HTMLElement {
    if (!node) return false;
    const candidate = node as { tagName?: string };
    return typeof candidate.tagName === 'string' && /^H[1-3]$/i.test(candidate.tagName);
  }

  private isWithinOutlineTextBlock(node: Node | null): boolean {
    let current = node;
    while (current && current !== this.messagesEl) {
      const candidate = current as { classList?: { contains?: (className: string) => boolean } };
      if (candidate.classList?.contains?.('claudian-text-block') === true) return true;
      current = current.parentNode;
    }
    return false;
  }

  private nodeContainsOutlineHeading(node: Node, context: Node): boolean {
    if (this.isOutlineHeadingElement(node)) {
      return this.isWithinOutlineTextBlock(node) || this.isWithinOutlineTextBlock(context);
    }

    const candidate = node as {
      classList?: { contains?: (className: string) => boolean };
      querySelector?: (selector: string) => Element | null;
      querySelectorAll?: (selector: string) => NodeListOf<HTMLElement>;
    };
    if (typeof candidate.querySelector !== 'function') return false;
    if (
      this.isWithinOutlineTextBlock(context)
      && candidate.querySelector('h1, h2, h3') !== null
    ) {
      return true;
    }
    if (
      candidate.classList?.contains?.('claudian-text-block') === true
      && candidate.querySelector('h1, h2, h3') !== null
    ) {
      return true;
    }
    if (typeof candidate.querySelectorAll !== 'function') return false;
    return Array.from(candidate.querySelectorAll('.claudian-text-block'))
      .some(textBlock => textBlock.querySelector('h1, h2, h3') !== null);
  }

  private mutationAffectsOutline(mutation: MutationRecord): boolean {
    if (mutation.type === 'attributes') {
      return mutation.attributeName === 'data-toc-title'
        && this.isDirectoryMessageElement(mutation.target);
    }
    if (mutation.type === 'characterData') {
      return this.isOutlineHeadingElement(mutation.target.parentNode)
        && this.isWithinOutlineTextBlock(mutation.target.parentNode);
    }
    if (mutation.type !== 'childList') return false;
    if (
      this.isOutlineHeadingElement(mutation.target)
      && this.isWithinOutlineTextBlock(mutation.target)
    ) {
      return true;
    }
    return Array.from(mutation.addedNodes).some(node => (
      this.nodeContainsDirectoryMessage(node)
      || this.nodeContainsOutlineHeading(node, mutation.target)
    )) || Array.from(mutation.removedNodes).some(node => (
      this.nodeContainsDirectoryMessage(node)
      || this.nodeContainsOutlineHeading(node, mutation.target)
    ));
  }

  private refreshOutline(dirtyMessages: Set<HTMLElement> | null = null): void {
    const nextEntries = this.collectOutlineEntries(dirtyMessages);
    if (this.hasSameOutlineStructure(nextEntries)) {
      const previewMarkerIndex = this.outlinePreviewTrigger
        ? this.outlineMarkers.indexOf(this.outlinePreviewTrigger)
        : -1;
      nextEntries.forEach((entry, index) => {
        this.outlineEntries[index].targetEl = entry.targetEl;
        this.outlineEntries[index].messageEl = entry.messageEl;
        this.outlineEntries[index].excerpt = entry.excerpt;
        this.outlineEntries[index].headingIndex = entry.headingIndex;
        this.outlineEntries[index].headingOccurrence = entry.headingOccurrence;
      });
      if (previewMarkerIndex >= 0) {
        this.showOutlinePreview(
          this.outlineEntries[previewMarkerIndex],
          this.outlineMarkers[previewMarkerIndex],
        );
      }
      this.applyActiveOutline();
      return;
    }

    const activeElement = this.parentEl.ownerDocument.activeElement as HTMLElement | null;
    const focusedMarkerIndex = activeElement
      ? this.outlineMarkers.indexOf(activeElement)
      : -1;
    this.hideOutlinePreview();
    this.outlineEntries = nextEntries;
    this.outlineMarkers = [];
    this.activeOutlineIndex = null;
    this.outlineTrack.empty();
    this.tocBtn.classList.toggle('has-outline', this.outlineEntries.length > 0);

    this.outlineEntries.forEach((entry, index) => {
      const marker = this.outlineTrack.createEl('button', {
        cls: 'claudian-nav-outline-marker',
        attr: {
          type: 'button',
          'aria-label': `${entry.badge}: ${entry.title}`,
          'data-outline-kind': entry.kind,
          'data-outline-level': String(entry.level),
        },
      });
      this.positionOutlineMarker(marker, index);
      this.outlineMarkers.push(marker);

      const selectEntry = (event?: Event): void => {
        event?.stopPropagation();
        this.scrollToElement(this.resolveEntryTarget(entry));
        this.hideOutlinePreview();
      };
      marker.addEventListener('click', selectEntry);
      marker.addEventListener('mouseenter', () => this.showOutlinePreview(entry, marker));
      marker.addEventListener('mouseleave', () => this.hideOutlinePreview());
      marker.addEventListener('focus', () => this.showOutlinePreview(entry, marker));
      marker.addEventListener('blur', () => this.hideOutlinePreview());
      marker.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          this.hideOutlinePreview();
        }
      });
    });

    this.applyActiveOutline();
    if (focusedMarkerIndex >= 0) {
      const nextFocusTarget = this.outlineMarkers[
        Math.min(focusedMarkerIndex, this.outlineMarkers.length - 1)
      ] ?? this.tocBtn;
      nextFocusTarget.focus({ preventScroll: true });
    }
    this.refreshOpenDirectory(this.outlineEntries);
  }

  private applyActiveOutline(): void {
    if (this.outlineMarkers.length === 0 || this.outlineEntries.length === 0) return;

    const readingLine = this.messagesEl.scrollTop + this.messagesEl.clientHeight * 0.25;
    const canUseRects = typeof this.messagesEl.getBoundingClientRect === 'function';
    const containerRect = canUseRects ? this.messagesEl.getBoundingClientRect() : null;
    let activeIndex = 0;
    let low = 0;
    let high = this.outlineEntries.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const middleTop = this.getElementTop(
        this.resolveEntryTarget(this.outlineEntries[middle]),
        containerRect,
      );
      if (middleTop <= readingLine) {
        activeIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (this.activeOutlineIndex === activeIndex) {
      if (this.outlineTrack.clientHeight !== this.lastOutlineTrackHeight) {
        this.scrollActiveMarkerIntoView(this.outlineMarkers[activeIndex]);
      }
      return;
    }

    if (this.activeOutlineIndex !== null) {
      const previousMarker = this.outlineMarkers[this.activeOutlineIndex];
      previousMarker?.classList.remove('is-active');
      previousMarker?.setAttribute('aria-current', 'false');
    }
    const activeMarker = this.outlineMarkers[activeIndex];
    activeMarker.classList.add('is-active');
    activeMarker.setAttribute('aria-current', 'location');
    this.activeOutlineIndex = activeIndex;
    this.scrollActiveMarkerIntoView(activeMarker);
  }

  private scrollActiveMarkerIntoView(marker: HTMLElement): void {
    const trackHeight = this.outlineTrack.clientHeight;
    this.lastOutlineTrackHeight = trackHeight;
    if (trackHeight <= 0) return;

    let markerTop = marker.offsetTop;
    if (
      typeof marker.getBoundingClientRect === 'function'
      && typeof this.outlineTrack.getBoundingClientRect === 'function'
    ) {
      const markerRect = marker.getBoundingClientRect();
      const trackRect = this.outlineTrack.getBoundingClientRect();
      markerTop = this.outlineTrack.scrollTop + markerRect.top - trackRect.top;
    }
    const markerBottom = markerTop + marker.offsetHeight;
    const viewportTop = this.outlineTrack.scrollTop;
    const viewportBottom = viewportTop + trackHeight;
    const padding = 8;

    if (markerTop < viewportTop + padding) {
      this.outlineTrack.scrollTo({
        top: Math.max(markerTop - padding, 0),
        behavior: 'auto',
      });
    } else if (markerBottom > viewportBottom - padding) {
      this.outlineTrack.scrollTo({
        top: markerBottom - trackHeight + padding,
        behavior: 'auto',
      });
    }
  }

  private positionOutlineMarker(marker: HTMLElement, index: number): void {
    const count = this.outlineEntries.length;
    const gap = count > 1
      ? Math.min(OUTLINE_COMPACT_MAX_GAP_PX, OUTLINE_COMPACT_MAX_SPAN_PX / (count - 1))
      : 0;
    const offset = (index - (count - 1) / 2) * gap;
    marker.style.setProperty('--claudian-outline-offset', `${offset.toFixed(2)}px`);
  }

  private showOutlinePreview(entry: ConversationOutlineEntry, marker: HTMLElement): void {
    this.hideOutlinePreview();
    this.resolveEntryTarget(entry);
    const preview = this.parentEl.createDiv({ cls: 'claudian-nav-outline-preview' });
    const previewId = `claudian-outline-preview-${++nextOutlinePreviewId}`;
    preview.setAttribute('id', previewId);
    preview.setAttribute('role', 'tooltip');
    marker.setAttribute('aria-describedby', previewId);
    preview.createDiv({ cls: 'claudian-nav-outline-preview-badge', text: entry.badge });
    preview.createDiv({ cls: 'claudian-nav-outline-preview-title', text: entry.title });
    if (entry.excerpt) {
      preview.createDiv({
        cls: 'claudian-nav-outline-preview-excerpt',
        text: entry.excerpt,
      });
    }
    this.positionOutlinePreview(preview, marker);
    this.outlinePreview = preview;
    this.outlinePreviewTrigger = marker;
  }

  private positionOutlinePreview(preview: HTMLElement, marker: HTMLElement): void {
    const parentRect = this.parentEl.getBoundingClientRect?.();
    const markerRect = marker.getBoundingClientRect?.();
    if (!parentRect || !markerRect || parentRect.height <= 0) return;

    const markerCenter = markerRect.top - parentRect.top + markerRect.height / 2;
    const top = Math.max(12, Math.min(markerCenter, parentRect.height - 12));
    preview.style.setProperty('--claudian-outline-preview-top', `${top}px`);
  }

  private hideOutlinePreview(): void {
    this.outlinePreviewTrigger?.removeAttribute('aria-describedby');
    this.outlinePreview?.remove();
    this.outlinePreview = null;
    this.outlinePreviewTrigger = null;
  }

  private nodeContainsDirectoryMessage(node: Node): boolean {
    if (this.isDirectoryMessageElement(node)) return true;
    const candidate = node as { querySelector?: (selector: string) => Element | null };
    return typeof candidate.querySelector === 'function'
      && candidate.querySelector('.claudian-message-user, [data-role="user"]') !== null;
  }

  private isDirectoryMessageElement(node: Node): boolean {
    const candidate = node as {
      matches?: (selector: string) => boolean;
      classList?: { contains?: (className: string) => boolean };
      getAttribute?: (name: string) => string | null;
    };
    if (typeof candidate.matches === 'function') {
      return candidate.matches('.claudian-message-user, [data-role="user"]');
    }
    return candidate.classList?.contains?.('claudian-message-user') === true
      || candidate.getAttribute?.('data-role') === 'user';
  }

  private toggleDirectory(): void {
    if (this.tocPopover) {
      this.closeDirectory();
      return;
    }
    this.openDirectory();
  }

  private openDirectory(
    entries: ConversationOutlineEntry[] = this.getDirectoryEntries(),
    focusIndex: number | null = null,
  ): void {
    this.closeDirectory();
    this.hideOutlinePreview();
    this.tocPopover = this.parentEl.createDiv({ cls: 'claudian-nav-toc-popover' });
    const titleId = `${this.directoryPopoverId}-title`;
    this.tocPopover.setAttribute('id', this.directoryPopoverId);
    this.tocPopover.setAttribute('role', 'dialog');
    this.tocPopover.setAttribute('aria-labelledby', titleId);
    this.tocPopover.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.closeDirectory(true);
    });
    this.tocBtn.setAttribute('aria-expanded', 'true');
    const titleEl = this.tocPopover.createDiv({
      cls: 'claudian-nav-toc-title',
      text: 'Conversation directory',
    });
    titleEl.setAttribute('id', titleId);
    const listEl = this.tocPopover.createDiv({ cls: 'claudian-nav-toc-list' });

    if (entries.length === 0) {
      listEl.createDiv({
        cls: 'claudian-nav-toc-empty',
        text: 'No outline entries in this conversation',
      });
      return;
    }

    entries.forEach((entry, index) => {
      const itemEl = listEl.createEl('button', {
        cls: 'claudian-nav-toc-item',
        text: `${index + 1}. ${entry.title}`,
        attr: {
          type: 'button',
          title: entry.title,
          'data-outline-kind': entry.kind,
          'data-outline-level': String(entry.level),
          'data-outline-index': String(index),
        },
      });

      const selectEntry = () => {
        this.scrollToElement(this.resolveEntryTarget(entry));
        this.closeDirectory(true);
      };
      itemEl.addEventListener('click', selectEntry);
    });

    if (focusIndex !== null) {
      const focusTarget = listEl.querySelector<HTMLElement>(
        `[data-outline-index="${Math.min(focusIndex, entries.length - 1)}"]`,
      );
      focusTarget?.focus({ preventScroll: true });
    }
  }

  private refreshOpenDirectory(entries: ConversationOutlineEntry[]): void {
    if (!this.tocPopover) return;
    const activeElement = this.parentEl.ownerDocument.activeElement as HTMLElement | null;
    const focusIndex = activeElement && this.tocPopover.contains(activeElement)
      ? Number(activeElement.getAttribute('data-outline-index'))
      : null;
    this.openDirectory(entries, Number.isFinite(focusIndex) ? focusIndex : null);
  }

  private closeDirectory(restoreFocus = false): void {
    this.tocPopover?.remove();
    this.tocPopover = null;
    this.tocBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.tocBtn.focus({ preventScroll: true });
  }

  private scrollToElement(el: HTMLElement): void {
    this.messagesEl.scrollTo({
      top: Math.max(this.getElementTop(el) - 10, 0),
      behavior: this.getScrollBehavior(),
    });
  }

  private getScrollBehavior(): ScrollBehavior {
    const ownerWindow = this.messagesEl.ownerDocument.defaultView;
    return ownerWindow?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';
  }

  private getElementTop(el: HTMLElement, containerRect: DOMRect | null = null): number {
    if (
      typeof el.getBoundingClientRect === 'function'
      && typeof this.messagesEl.getBoundingClientRect === 'function'
    ) {
      const targetRect = el.getBoundingClientRect();
      const resolvedContainerRect = containerRect ?? this.messagesEl.getBoundingClientRect();
      return this.messagesEl.scrollTop + targetRect.top - resolvedContainerRect.top;
    }

    let top = 0;
    let current: HTMLElement | null = el;
    while (current && current !== this.messagesEl) {
      top += current.offsetTop;
      current = current.parentElement;
    }
    return top;
  }

  /**
   * Scrolls to previous or next user message, skipping assistant messages.
   */
  private scrollToMessage(direction: 'prev' | 'next'): void {
    const messages = Array.from(this.messagesEl.querySelectorAll<HTMLElement>('.claudian-message-user'));

    if (messages.length === 0) return;

    const scrollTop = this.messagesEl.scrollTop;
    const threshold = 30;

    if (direction === 'prev') {
      // Find the last message strictly above the current scroll position
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].offsetTop < scrollTop - threshold) {
          this.scrollToElement(messages[i]);
          return;
        }
      }
      // Already at or above the first message — scroll to top
      this.messagesEl.scrollTo({ top: 0, behavior: this.getScrollBehavior() });
    } else {
      // Find the first message strictly below the current scroll position
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].offsetTop > scrollTop + threshold) {
          this.scrollToElement(messages[i]);
          return;
        }
      }
      // Already at or past the last message — scroll to bottom
      this.messagesEl.scrollTo({
        top: this.messagesEl.scrollHeight,
        behavior: this.getScrollBehavior(),
      });
    }
  }

  collapse(): void {
    this.hideOutlinePreview();
    this.closeDirectory();
  }

  destroy(): void {
    if (this.pendingVisibilityFrame !== null) {
      cancelScheduledAnimationFrame(this.pendingVisibilityFrame);
      this.pendingVisibilityFrame = null;
    }
    if (this.pendingOutlineRefresh !== null) {
      this.pendingOutlineRefresh.ownerWindow.clearTimeout(this.pendingOutlineRefresh.id);
      this.pendingOutlineRefresh = null;
    }
    this.pendingOutlineMessages.clear();
    this.outlineEntriesByMessage.clear();
    this.collapse();
    if (this.outsideClickHandler) {
      this.parentEl.ownerDocument?.removeEventListener?.('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.messagesEl.removeEventListener('scroll', this.scrollHandler);
    this.container.remove();
  }
}
