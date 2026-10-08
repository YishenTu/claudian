import type { ZenModePosition } from '@/core/types';
import { dockOutlinePath, type OutlineBox } from '@/features/chat/zen/dockOutline';

const DRAGGING_CLASS = 'claudian-zen--dragging';
const SNAPPED_CLASS = 'claudian-zen--snapped';
const HINT_CLASS = 'claudian-zen-dock-hint';
const HINT_ACTIVE_CLASS = 'claudian-zen-dock-hint--active';
const OPENS_BELOW_CLASS = 'claudian-zen--opens-below';
const OFFSET_X_PROPERTY = '--claudian-zen-offset-x';
const OFFSET_Y_PROPERTY = '--claudian-zen-offset-y';
const INSET_PROPERTY = '--claudian-zen-inset';
const PADDING_PROPERTY = '--claudian-zen-padding';
const COMPOSER_RADIUS_PROPERTY = '--claudian-zen-composer-radius';
const SVG_NS = 'http://www.w3.org/2000/svg';
// A dragged panel released this close to its dock snaps back into it.
const DOCK_SNAP_DISTANCE = 32;
const KEY_STEP = 16;
const LARGE_KEY_STEP = 64;

/** Bottom-center offset from the dock in pixels; y grows upward. */
interface Offset {
  readonly x: number;
  readonly y: number;
}

const DOCKED: Offset = { x: 0, y: 0 };

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly origin: Offset;
}

export interface ZenPanelDockElements {
  readonly hostEl: HTMLElement;
  readonly rootEl: HTMLElement;
  readonly gripEl: HTMLElement;
  /** The narrower drawer above the composer; while shown, it shapes the dock hint. */
  readonly drawerEl: HTMLElement;
  /** The composer: its menus open above or below it, and it shapes the dock hint. */
  readonly composerEl: HTMLElement;
}

export interface ZenPanelDockOptions {
  readonly position: ZenModePosition | null;
  onPositionChange(position: ZenModePosition | null): void;
}

/**
 * Owns where the floating panel sits in its host: grip dragging and keys, the magnetic
 * dock, and keeping the panel inside the host. The remembered position stays as the
 * user left it; only its rendering is clamped, so a temporary squeeze recovers.
 */
export class ZenPanelDock {
  #position: ZenModePosition | null;
  #rendered: Offset = DOCKED;
  #drag: Drag | null = null;
  // Marks the dock while a drag is in progress.
  #hintEl: HTMLElement | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #destroyed = false;
  readonly #hostEl: HTMLElement;
  readonly #rootEl: HTMLElement;
  readonly #gripEl: HTMLElement;
  readonly #drawerEl: HTMLElement;
  readonly #composerEl: HTMLElement;

  constructor(elements: ZenPanelDockElements, private readonly options: ZenPanelDockOptions) {
    const { hostEl, rootEl, gripEl } = elements;
    this.#hostEl = hostEl;
    this.#rootEl = rootEl;
    this.#gripEl = gripEl;
    this.#drawerEl = elements.drawerEl;
    this.#composerEl = elements.composerEl;
    this.#position = options.position;
    gripEl.addEventListener('pointerdown', this.#handlePointerDown);
    gripEl.addEventListener('keydown', this.#handleKeyDown);
    gripEl.addEventListener('dblclick', this.#dock);
    const ResizeObserverConstructor = hostEl.ownerDocument.defaultView?.ResizeObserver;
    if (typeof ResizeObserverConstructor === 'function') {
      // The host follows window and sidebar resizes; the panel grows with history and typed text.
      this.#resizeObserver = new ResizeObserverConstructor(() => this.#apply());
      this.#resizeObserver.observe(hostEl);
      this.#resizeObserver.observe(rootEl);
    }
    this.#apply();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#endDrag();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#gripEl.removeEventListener('pointerdown', this.#handlePointerDown);
    this.#gripEl.removeEventListener('keydown', this.#handleKeyDown);
    this.#gripEl.removeEventListener('dblclick', this.#dock);
  }

  #apply(): void {
    if (this.#destroyed) return;
    // Mid-drag, streamed history can grow the panel; keep the dragged spot inside the host.
    if (this.#drag) {
      this.#render(this.#clamp(this.#rendered));
      return;
    }
    const { width, height } = this.#hostSize();
    const position = this.#position;
    this.#render(this.#clamp(position ? { x: position.x * width, y: position.y * height } : DOCKED));
  }

  #render(offset: Offset): void {
    this.#rendered = offset;
    this.#rootEl.style.setProperty(OFFSET_X_PROPERTY, `${Math.round(offset.x)}px`);
    this.#rootEl.style.setProperty(OFFSET_Y_PROPERTY, `${Math.round(offset.y)}px`);
    // Menus open from the composer toward the side with more room; history above it does not count.
    const hostRect = this.#hostEl.getBoundingClientRect();
    const anchorRect = this.#composerEl.getBoundingClientRect();
    this.#rootEl.toggleClass(OPENS_BELOW_CLASS, hostRect.bottom - anchorRect.bottom > anchorRect.top - hostRect.top);
    if (this.#drag) {
      const snapped = offset.x === 0 && offset.y === 0;
      this.#rootEl.toggleClass(SNAPPED_CLASS, snapped);
      this.#hintEl?.toggleClass(HINT_ACTIVE_CLASS, snapped);
    }
  }

  #commit(offset: Offset): void {
    this.#render(offset);
    const { width, height } = this.#hostSize();
    // A hidden host has no size to measure against; keep what was remembered.
    if (width <= 0 || height <= 0) return;
    const position = offset.x === 0 && offset.y === 0
      ? null
      : { x: roundFraction(offset.x / width), y: roundFraction(offset.y / height) };
    const previous = this.#position;
    if (position?.x === previous?.x && position?.y === previous?.y) return;
    this.#position = position;
    this.options.onPositionChange(position);
  }

  /** Keeps the whole panel inside the host, at least an inset from every edge. */
  #clamp(offset: Offset): Offset {
    const { width, height } = this.#hostSize();
    const rect = this.#rootEl.getBoundingClientRect();
    const inset = this.#inset();
    const maxX = Math.max(0, (width - rect.width) / 2 - inset);
    const maxY = Math.max(0, height - 2 * inset - rect.height);
    return { x: clamp(offset.x, -maxX, maxX), y: clamp(offset.y, 0, maxY) };
  }

  #hostSize(): { width: number; height: number } {
    return { width: this.#hostEl.clientWidth, height: this.#hostEl.clientHeight };
  }

  #inset(): number {
    return pixels(this.#hostEl.ownerDocument.defaultView?.getComputedStyle(this.#hostEl).getPropertyValue(INSET_PROPERTY));
  }

  readonly #dock = (): void => {
    this.#commit(DOCKED);
  };

  readonly #handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#drag) return;
    // Keeps the drag from selecting note text underneath.
    event.preventDefault();
    this.#drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: this.#rendered };
    this.#rootEl.addClass(DRAGGING_CLASS);
    this.#hintEl = this.#createHint();
    this.#render(this.#rendered);
    const doc = this.#hostEl.ownerDocument;
    doc.addEventListener('pointermove', this.#handlePointerMove);
    doc.addEventListener('pointerup', this.#handlePointerUp);
    doc.addEventListener('pointercancel', this.#handlePointerUp);
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    const drag = this.#drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#render(this.#snap(this.#clamp({
      x: drag.origin.x + event.clientX - drag.startX,
      y: drag.origin.y - (event.clientY - drag.startY),
    })));
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    if (!this.#drag || event.pointerId !== this.#drag.pointerId) return;
    this.#endDrag();
    // Growth since the last move may not have been observed yet.
    this.#commit(this.#clamp(this.#rendered));
  };

  #endDrag(): void {
    if (!this.#drag) return;
    this.#drag = null;
    this.#rootEl.removeClass(DRAGGING_CLASS, SNAPPED_CLASS);
    this.#hintEl?.remove();
    this.#hintEl = null;
    const doc = this.#hostEl.ownerDocument;
    doc.removeEventListener('pointermove', this.#handlePointerMove);
    doc.removeEventListener('pointerup', this.#handlePointerUp);
    doc.removeEventListener('pointercancel', this.#handlePointerUp);
  }

  /** Sized like the panel at its dock, beneath it, tracing the panel's surfaces a gap outside them. */
  #createHint(): HTMLElement {
    const rootRect = this.#rootEl.getBoundingClientRect();
    const hintEl = this.#hostEl.createDiv({ cls: HINT_CLASS, attr: { 'aria-hidden': 'true' } });
    hintEl.style.width = `${Math.round(rootRect.width)}px`;
    hintEl.style.height = `${Math.round(rootRect.height)}px`;

    const view = this.#hostEl.ownerDocument.defaultView;
    const hostStyle = view?.getComputedStyle(this.#hostEl);
    const gap = pixels(hostStyle?.getPropertyValue(PADDING_PROPERTY)) / 2;
    const toBox = (rect: DOMRect, radius: number): OutlineBox => ({
      left: rect.left - rootRect.left - gap,
      top: rect.top - rootRect.top - gap,
      right: rect.right - rootRect.left + gap,
      bottom: rect.bottom - rootRect.top + gap,
      radius: radius + gap,
    });
    const composer = toBox(
      this.#composerEl.getBoundingClientRect(),
      pixels(hostStyle?.getPropertyValue(COMPOSER_RADIUS_PROPERTY)),
    );
    const drawerRect = this.#drawerEl.getBoundingClientRect();
    const drawer = drawerRect.height > 0
      ? toBox(drawerRect, pixels(view?.getComputedStyle(this.#drawerEl).borderTopLeftRadius))
      : null;
    // The drawer's open bottom stands on the composer's top edge.
    const d = dockOutlinePath(composer, drawer && { ...drawer, bottom: composer.top });

    const doc = this.#hostEl.ownerDocument;
    const svgEl = doc.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('class', 'claudian-zen-dock-hint-shape');
    for (const cls of ['claudian-zen-dock-hint-glow', 'claudian-zen-dock-hint-outline']) {
      const pathEl = doc.createElementNS(SVG_NS, 'path');
      pathEl.setAttribute('class', cls);
      pathEl.setAttribute('d', d);
      svgEl.appendChild(pathEl);
    }
    hintEl.appendChild(svgEl);
    return hintEl;
  }

  #snap(offset: Offset): Offset {
    return Math.hypot(offset.x, offset.y) <= DOCK_SNAP_DISTANCE ? DOCKED : offset;
  }

  /** Keys move in steps without the magnet, which would hold the panel in its dock; Home docks it. */
  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (this.#drag) return;
    if (event.key === 'Home') {
      event.preventDefault();
      this.#dock();
      return;
    }
    const step = event.shiftKey ? LARGE_KEY_STEP : KEY_STEP;
    const delta = KEY_DELTAS[event.key];
    if (!delta) return;
    event.preventDefault();
    this.#commit(this.#clamp({ x: this.#rendered.x + delta.x * step, y: this.#rendered.y + delta.y * step }));
  };
}

const KEY_DELTAS: Partial<Record<string, Offset>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundFraction(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
