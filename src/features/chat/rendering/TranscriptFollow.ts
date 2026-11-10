import type { KeyboardNavigationSettings } from '@/core/types/settings';

/** The distance from the bottom that still counts as reading the latest message. */
const AT_BOTTOM_THRESHOLD = 20;

/**
 * Where the reader wants the transcript, as their actions last expressed it.
 * - `landing`: a settled transcript just opened; late content keeps its end in view until the
 *   reader acts or the first arrival.
 * - `landing-until-layout`: a hidden transcript lands once laid out, then follows as `following`;
 *   used when live growth must not keep landing (a streaming reply, an arrival while hidden).
 * - `following`: at the bottom; content growth is followed when "Auto-scroll during streaming" allows.
 * - `paused`: the reader moved away.
 * - `navigating-*`: a navigation scroll is in flight; geometry-only scroll events cannot change it.
 */
type FollowPhase = 'landing' | 'landing-until-layout' | 'following' | 'paused' | 'navigating-bottom' | 'navigating-away';

export type NavigationScrollIntent = 'away' | 'bottom';

/** Reading intent captured before a transcript is relocated. */
export interface TranscriptScrollSnapshot {
  readonly top: number;
  readonly follow: boolean;
}

export interface TranscriptFollowSettings {
  readonly enableAutoScroll?: boolean;
  readonly keyboardNavigation: Pick<KeyboardNavigationSettings, 'scrollUpKey' | 'scrollDownKey'>;
}

const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
const POINTER_RELEASE_EVENTS = ['pointerup', 'pointercancel'] as const;
const NATIVE_BOUNDARY_SCROLL_KEYS = new Set(['end', 'home']);
const NATIVE_PAGE_SCROLL_KEYS = new Set(['pagedown', 'pageup']);
const NATIVE_ARROW_SCROLL_KEYS = new Set(['arrowdown', 'arrowup']);

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

/**
 * The sole owner of whether a transcript presentation follows its latest content: the
 * reader's scroll intent, the auto-scroll setting gate, and every write that moves the
 * reader to the bottom. Main and side chat each own one through their `MessageRenderer`.
 *
 * While following, any resize of the transcript's messages keeps the reader at the bottom,
 * so streamed text, late Markdown, diagrams and images need no follow requests of their own.
 */
export class TranscriptFollow {
  #phase: FollowPhase = 'following';
  // Counts moves away from the end, so a held arrival knows whether the reader left after it.
  #awayRevision = 0;
  // Independent facts: a held pointer can drag-select past the edge, and the reading position
  // survives relocation; neither is a follow stage.
  #pointerHeld = false;
  #readingTop = 0;
  #viewportHeight: number;
  #disposed = false;
  readonly #resizeObserver: ResizeObserver | null;
  readonly #childObserver: MutationObserver | null;
  readonly #pointerDocument: Document;

  constructor(
    private readonly messagesEl: HTMLElement,
    private readonly getSettings: () => TranscriptFollowSettings,
  ) {
    this.#viewportHeight = messagesEl.clientHeight;
    this.#pointerDocument = messagesEl.ownerDocument;
    const view = messagesEl.ownerDocument.defaultView;
    const Resize = view?.ResizeObserver;
    this.#resizeObserver = Resize ? new Resize(() => this.#onResize()) : null;
    this.#resizeObserver?.observe(messagesEl);
    for (const child of Array.from(messagesEl.children)) this.#resizeObserver?.observe(child);
    const Mutation = view?.MutationObserver;
    this.#childObserver = Mutation && this.#resizeObserver ? new Mutation(records => {
      if (this.#disposed) return;
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) if (isElement(node)) this.#resizeObserver?.unobserve(node);
        for (const node of Array.from(record.addedNodes)) if (isElement(node)) this.#resizeObserver?.observe(node);
      }
    }) : null;
    this.#childObserver?.observe(messagesEl, { childList: true });
    for (const name of USER_SCROLL_EVENTS) messagesEl.addEventListener(name, this.#onUserScrollIntent, { passive: true });
    for (const name of POINTER_RELEASE_EVENTS) {
      this.#pointerDocument.addEventListener(name, this.#onPointerRelease, { capture: true, passive: true });
    }
    messagesEl.addEventListener('scroll', this.#onScroll, { passive: true });
  }

  /**
   * A transcript was rendered for opening: show its end. A settled transcript keeps it in view
   * while late content lays out; one with a reply still streaming then follows as the setting allows.
   */
  land({ streaming = false } = {}): void {
    const laidOut = this.messagesEl.clientHeight > 0;
    this.#setPhase(!streaming ? 'landing' : laidOut ? 'following' : 'landing-until-layout');
    this.#pin();
  }

  /** The reader's own send: show it, and follow its reply as the setting allows. */
  reveal(): void {
    this.#setPhase('following');
    this.#pin();
  }

  /** A restored reading position: keep it, unless it is the end. */
  keepReadingPosition(): void {
    this.#setPhase(this.#isAtBottom() ? 'following' : 'paused');
  }

  /**
   * Call before rendering an arrival, since content added below moves the reader off the bottom.
   * The returned call brings the arrival into view only for a reader who was at the bottom and
   * has not scrolled up since; following only moves down, while content that shrinks clamps
   * the reader to the bottom.
   */
  holdArrival(): () => void {
    // An arrival ends landing, so a reply streamed after it follows only as the setting allows;
    // one rendered while hidden still lands when the transcript is shown.
    if (this.#phase === 'landing') this.#setPhase(this.messagesEl.clientHeight > 0 ? 'following' : 'landing-until-layout');
    if (!this.#isAtBottom()) return () => undefined;
    const revision = this.#awayRevision;
    return () => {
      // Content that shrinks can still clamp a reader who left back to the end.
      if (revision === this.#awayRevision || this.#isAtBottom()) this.#pin();
    };
  }

  setNavigationIntent(intent: NavigationScrollIntent): void {
    this.#setPhase(intent === 'bottom' ? 'navigating-bottom' : 'navigating-away');
  }

  capture(): TranscriptScrollSnapshot {
    return { top: this.#readingTop, follow: this.#isFollowing() };
  }

  /** Relocation can emit geometry-only scroll events; this reapplies the captured intent. */
  restore(snapshot: TranscriptScrollSnapshot = this.capture()): void {
    this.#readingTop = snapshot.top;
    if (snapshot.follow) {
      if (!this.#isFollowing()) this.#setPhase('following');
      this.#pin();
      return;
    }
    if (this.#isFollowing()) this.#setPhase('paused');
    this.messagesEl.scrollTop = snapshot.top;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resizeObserver?.disconnect();
    this.#childObserver?.disconnect();
    for (const name of USER_SCROLL_EVENTS) this.messagesEl.removeEventListener(name, this.#onUserScrollIntent);
    for (const name of POINTER_RELEASE_EVENTS) {
      this.#pointerDocument.removeEventListener(name, this.#onPointerRelease, { capture: true });
    }
    this.messagesEl.removeEventListener('scroll', this.#onScroll);
  }

  #setPhase(phase: FollowPhase): void {
    if (phase === 'paused' || phase === 'navigating-away') this.#awayRevision++;
    this.#phase = phase;
  }

  #isFollowing(): boolean {
    switch (this.#phase) {
      case 'landing':
      case 'landing-until-layout': return true;
      case 'following':
      case 'navigating-bottom': return this.getSettings().enableAutoScroll ?? true;
      default: return false;
    }
  }

  #isAtBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
    return scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_THRESHOLD;
  }

  #pin(): void {
    if (this.#disposed) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  #onResize(): void {
    const height = this.messagesEl.clientHeight;
    const previous = this.#viewportHeight;
    this.#viewportHeight = height;
    // A hidden presentation ignores scroll writes; its first layout resizes it again.
    if (height === 0) return;
    const { scrollTop, scrollHeight } = this.messagesEl;
    // A shrinking viewport (a growing composer) keeps a reader who was at the bottom there.
    const keepsBottom = height < previous && scrollHeight - scrollTop - previous <= AT_BOTTOM_THRESHOLD;
    if (keepsBottom || this.#isFollowing()) this.#pin();
    if (this.#phase === 'landing-until-layout') this.#setPhase('following');
  }

  #onScroll = (): void => {
    const height = this.messagesEl.clientHeight;
    if (height > 0) {
      this.#readingTop = this.messagesEl.scrollTop;
      this.#viewportHeight = height;
    }
    if (this.#phase === 'navigating-bottom') return;
    if (!this.#isAtBottom()) {
      // Layout changes also emit scroll events; only the reader's intent pauses following.
      if (this.#phase === 'navigating-away' || this.#pointerHeld) this.#setPhase('paused');
      return;
    }
    if (this.#phase === 'paused') this.#setPhase('following');
  };

  #onPointerRelease = (): void => {
    this.#pointerHeld = false;
  };

  #onUserScrollIntent = (event: Event): void => {
    if (event.type === 'wheel' && (event as WheelEvent).deltaY > 0 && this.#isAtBottom()) {
      // Downward momentum at the bottom keeps following, unless navigation just moved away.
      if (this.#phase !== 'navigating-away' && this.#phase !== 'navigating-bottom') this.#setPhase('following');
      return;
    }
    if (event.type === 'keydown' && !this.#isScrollKey(event as KeyboardEvent)) return;
    if (event.type === 'pointerdown') {
      const pointer = event as PointerEvent;
      // Scrollbar presses and middle-button autoscroll scroll without further input events.
      if (pointer.button !== 1 && !this.#isScrollbarPress(pointer)) {
        this.#pointerHeld = true;
        return;
      }
    }
    this.#setPhase('paused');
  };

  #isScrollKey(event: KeyboardEvent): boolean {
    const { scrollUpKey, scrollDownKey } = this.getSettings().keyboardNavigation;
    const key = event.key.toLowerCase();
    const hasControlModifier = event.ctrlKey || event.metaKey;
    const plain = !event.altKey && !event.shiftKey;
    if (plain && !hasControlModifier && (key === scrollUpKey.toLowerCase() || key === scrollDownKey.toLowerCase())) return true;
    const target = event.target as HTMLElement | null;
    const targetTag = target?.tagName;
    const isTextEntry = targetTag === 'INPUT' || targetTag === 'SELECT' || targetTag === 'TEXTAREA'
      || target?.isContentEditable === true;
    if (isTextEntry) return false;
    const isActivatable = targetTag === 'A' || targetTag === 'BUTTON' || targetTag === 'SUMMARY'
      || target?.getAttribute?.('role') === 'button';
    if (plain && NATIVE_BOUNDARY_SCROLL_KEYS.has(key)) return true;
    if (plain && !hasControlModifier && NATIVE_PAGE_SCROLL_KEYS.has(key)) return true;
    if (plain && !isActivatable && NATIVE_ARROW_SCROLL_KEYS.has(key)) return true;
    return key === ' ' && !hasControlModifier && !event.altKey && !isActivatable;
  }

  #isScrollbarPress(event: PointerEvent): boolean {
    const el = this.messagesEl;
    if (event.target !== el) return false;
    const scrollbarWidth = el.offsetWidth - el.clientWidth;
    if (scrollbarWidth <= 0 || el.scrollHeight <= el.clientHeight) return false;
    const bounds = el.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const direction = el.ownerDocument.defaultView?.getComputedStyle?.(el).direction;
    return direction === 'rtl' ? pointerX <= scrollbarWidth : pointerX >= bounds.width - scrollbarWidth;
  }
}
