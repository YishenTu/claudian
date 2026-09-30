import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../../utils/animationFrame';

const STACKED_CLASS = 'claudian-zen-composer--stacked';
// Room kept between the typed text and the controls before they move to their own row.
const CONTROL_CLEARANCE = 16;

interface MeasuredLine {
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  readonly inset: number;
}

/**
 * Keeps the zen composer's controls on the input row until the typed text would
 * reach them, then gives the text the whole row and the controls a row below.
 * It only toggles a class on the zen-owned slot; the moved composer is untouched.
 */
export class ZenComposerLayout {
  #pendingFrame: ScheduledAnimationFrame | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #mutationObserver: MutationObserver | null = null;
  #destroyed = false;

  constructor(private readonly slotEl: HTMLElement) {
    const ownerWindow = slotEl.ownerDocument.defaultView;
    const ResizeObserverConstructor = ownerWindow?.ResizeObserver;
    if (typeof ResizeObserverConstructor === 'function') {
      this.#resizeObserver = new ResizeObserverConstructor(() => this.#schedule());
      this.#resizeObserver.observe(slotEl);
    }
    const MutationObserverConstructor = ownerWindow?.MutationObserver;
    if (typeof MutationObserverConstructor === 'function') {
      // Typing, draft replacement, editor mounting and control label changes all mutate the slot's subtree.
      this.#mutationObserver = new MutationObserverConstructor((records) => {
        if (records.some(record => record.target !== slotEl)) this.#schedule();
      });
      this.#mutationObserver.observe(slotEl, {
        attributes: true,
        attributeFilter: ['class'],
        characterData: true,
        childList: true,
        subtree: true,
      });
    }
    this.#schedule();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#pendingFrame) cancelScheduledAnimationFrame(this.#pendingFrame);
    this.#pendingFrame = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#mutationObserver?.disconnect();
    this.#mutationObserver = null;
    this.slotEl.removeClass(STACKED_CLASS);
  }

  #schedule(): void {
    if (this.#destroyed || this.#pendingFrame) return;
    this.#pendingFrame = scheduleAnimationFrame(() => {
      this.#pendingFrame = null;
      this.#refresh();
    }, this.slotEl.ownerDocument.defaultView);
  }

  #refresh(): void {
    if (this.#destroyed) return;
    const stacked = this.#shouldStack();
    if (stacked !== null) this.slotEl.toggleClass(STACKED_CLASS, stacked);
  }

  /** Null keeps the current layout when there is nothing laid out to measure. */
  #shouldStack(): boolean | null {
    const wrapperEl = this.slotEl.querySelector<HTMLElement>('.claudian-input-wrapper');
    const editorEl = wrapperEl?.querySelector<HTMLElement>(':scope > .claudian-composer-editor');
    const toolbarEl = wrapperEl?.querySelector<HTMLElement>(':scope > .claudian-input-toolbar');
    if (!wrapperEl || !editorEl || !toolbarEl) return false;

    const style = this.slotEl.ownerDocument.defaultView?.getComputedStyle(wrapperEl);
    const innerWidth = wrapperEl.clientWidth - pixels(style?.paddingLeft) - pixels(style?.paddingRight);
    if (innerWidth <= 0) return null;

    const line = this.#measureLine(editorEl);
    if (line === 'multiple') return true;
    if (line === null) return false;
    // Text that already wraps beside the controls needs the whole row.
    if (Number.isFinite(line.lineHeight) && line.height > line.lineHeight * 1.5) return true;
    // Measured against the single-row width, so both layouts reach the same decision.
    const available = innerWidth - toolbarEl.getBoundingClientRect().width - line.inset - CONTROL_CLEARANCE;
    return line.width > available;
  }

  #measureLine(editorEl: HTMLElement): MeasuredLine | 'multiple' | null {
    const view = this.slotEl.ownerDocument.defaultView;
    const contentEl = editorEl.querySelector<HTMLElement>('.cm-content');
    // Before its first focus, the composer shows the draft as plain text.
    if (!contentEl) {
      const text = editorEl.textContent ?? '';
      if (!text) return null;
      if (text.includes('\n')) return 'multiple';
      return { ...this.#measureContents(editorEl), lineHeight: lineHeightOf(view?.getComputedStyle(editorEl)), inset: 0 };
    }

    const lines = contentEl.querySelectorAll<HTMLElement>(':scope > .cm-line');
    if (lines.length > 1) return 'multiple';
    const lineEl = lines[0];
    // The placeholder is truncated in place and never moves the controls.
    if (!lineEl || lineEl.querySelector('.cm-placeholder')) return null;
    const style = view?.getComputedStyle(lineEl);
    return {
      ...this.#measureContents(lineEl),
      lineHeight: lineHeightOf(style),
      inset: pixels(style?.paddingLeft) + pixels(style?.paddingRight),
    };
  }

  #measureContents(el: HTMLElement): { width: number; height: number } {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
}

function pixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function lineHeightOf(style: CSSStyleDeclaration | undefined): number {
  return Number.parseFloat(style?.lineHeight ?? '');
}
