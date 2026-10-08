import type { ZenModePosition } from '@/core/types';

const DRAGGING_CLASS = 'claudian-zen--dragging';
const SNAPPED_CLASS = 'claudian-zen--snapped';
const HINT_CLASS = 'claudian-zen-dock-hint';
const HINT_ACTIVE_CLASS = 'claudian-zen-dock-hint--active';
const OPENS_BELOW_CLASS = 'claudian-zen--opens-below';
const OFFSET_X_PROPERTY = '--claudian-zen-offset-x';
const OFFSET_Y_PROPERTY = '--claudian-zen-offset-y';
const INSET_PROPERTY = '--claudian-zen-inset';
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

  constructor(
    private readonly hostEl: HTMLElement,
    private readonly rootEl: HTMLElement,
    private readonly gripEl: HTMLElement,
    private readonly options: ZenPanelDockOptions,
  ) {
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
    this.gripEl.removeEventListener('pointerdown', this.#handlePointerDown);
    this.gripEl.removeEventListener('keydown', this.#handleKeyDown);
    this.gripEl.removeEventListener('dblclick', this.#dock);
  }

  #apply(): void {
    if (this.#destroyed || this.#drag) return;
    const { width, height } = this.#hostSize();
    const position = this.#position;
    this.#render(this.#clamp(position ? { x: position.x * width, y: position.y * height } : DOCKED));
  }

  #render(offset: Offset): void {
    this.#rendered = offset;
    this.rootEl.style.setProperty(OFFSET_X_PROPERTY, `${Math.round(offset.x)}px`);
    this.rootEl.style.setProperty(OFFSET_Y_PROPERTY, `${Math.round(offset.y)}px`);
    // Menus open toward the side with more room.
    const centerFromBottom = this.#inset() + offset.y + this.rootEl.getBoundingClientRect().height / 2;
    this.rootEl.toggleClass(OPENS_BELOW_CLASS, centerFromBottom > this.#hostSize().height / 2);
    if (this.#drag) {
      const snapped = offset.x === 0 && offset.y === 0;
      this.rootEl.toggleClass(SNAPPED_CLASS, snapped);
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
    const rect = this.rootEl.getBoundingClientRect();
    const inset = this.#inset();
    const maxX = Math.max(0, (width - rect.width) / 2 - inset);
    const maxY = Math.max(0, height - 2 * inset - rect.height);
    return { x: clamp(offset.x, -maxX, maxX), y: clamp(offset.y, 0, maxY) };
  }

  #hostSize(): { width: number; height: number } {
    return { width: this.hostEl.clientWidth, height: this.hostEl.clientHeight };
  }

  #inset(): number {
    const value = this.hostEl.ownerDocument.defaultView?.getComputedStyle(this.hostEl).getPropertyValue(INSET_PROPERTY);
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  readonly #dock = (): void => {
    this.#commit(DOCKED);
  };

  readonly #handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#drag) return;
    // Keeps the drag from selecting note text underneath.
    event.preventDefault();
    this.#drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: this.#rendered };
    this.rootEl.addClass(DRAGGING_CLASS);
    // Sized like the panel at its dock; it renders beneath the panel.
    const rect = this.rootEl.getBoundingClientRect();
    this.#hintEl = this.hostEl.createDiv({ cls: HINT_CLASS, attr: { 'aria-hidden': 'true' } });
    this.#hintEl.style.width = `${Math.round(rect.width)}px`;
    this.#hintEl.style.height = `${Math.round(rect.height)}px`;
    this.#render(this.#rendered);
    const doc = this.hostEl.ownerDocument;
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
    this.#commit(this.#rendered);
  };

  #endDrag(): void {
    if (!this.#drag) return;
    this.#drag = null;
    this.rootEl.removeClass(DRAGGING_CLASS, SNAPPED_CLASS);
    this.#hintEl?.remove();
    this.#hintEl = null;
    const doc = this.hostEl.ownerDocument;
    doc.removeEventListener('pointermove', this.#handlePointerMove);
    doc.removeEventListener('pointerup', this.#handlePointerUp);
    doc.removeEventListener('pointercancel', this.#handlePointerUp);
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

function roundFraction(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
