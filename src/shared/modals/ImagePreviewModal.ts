import { type Keymap, type Modifier, Scope, setIcon } from 'obsidian';

import type { ImageAttachment } from '@/core/types';
import { t } from '@/i18n/i18n';
import { setModalAccessibility } from '@/shared/modals/AccessibleModal';

/** Any image the browser can load: a data URL for attachments or a vault resource URL. */
export interface ImagePreviewSource {
  src: string;
  name: string;
}

export function imageAttachmentPreview(image: ImageAttachment): ImagePreviewSource {
  return { src: `data:${image.mediaType};base64,${image.data}`, name: image.name };
}

const KEY_ZOOM_STEP = 1.25;
const KEY_PAN_STEP_PX = 64;
/** Wheel deltas map to `exp(-delta * rate)`; a pinch reports far smaller deltas than a wheel. */
const WHEEL_ZOOM_RATE = 0.002;
const PINCH_ZOOM_RATE = 0.01;
/** Zooming out may shrink the image to this fraction of its fit size. */
const MIN_ZOOM = 0.25;
const MIN_MAX_ZOOM = 8;
const MAX_NATURAL_MULTIPLE = 4;
/** Pointer travel below this is a click, not a pan. */
const DRAG_THRESHOLD_PX = 3;

function getFocusableActiveElement(ownerDocument: Document): HTMLElement | null {
  const activeElement = ownerDocument.activeElement;
  if (!activeElement || typeof (activeElement as HTMLElement).focus !== 'function') {
    return null;
  }
  return activeElement as HTMLElement;
}

/**
 * The pointer gesture. A pan's release produces a click on the stage, and `panned` keeps that
 * click from dismissing the preview; the next press clears it.
 */
type Gesture =
  | { phase: 'idle' }
  | { phase: 'dragging'; startX: number; startY: number; originX: number; originY: number; moved: boolean }
  | { phase: 'panned' };

/**
 * Zoom and pan of one preview image. The image is laid out at its fit size, centered in the
 * stage; `scale` multiplies that fit size and `x`/`y` offset the center.
 */
class ImageZoom {
  private scale = 1;
  private x = 0;
  private y = 0;
  private gesture: Gesture = { phase: 'idle' };

  constructor(
    private readonly ownerDocument: Document,
    private readonly stage: HTMLElement,
    private readonly image: HTMLImageElement,
    private readonly level: HTMLElement,
  ) {
    image.addEventListener('load', () => this.render());
    stage.addEventListener('wheel', this.onWheel, { passive: false });
    stage.addEventListener('mousedown', this.onMouseDown);
    image.addEventListener('dblclick', this.onDoubleClick);
    // The stage fills the window, and CSS refits the image when the window resizes.
    ownerDocument.defaultView?.addEventListener('resize', this.onResize);
  }

  /** Fit-to-natural ratio, or null while the image has no decoded size or layout yet. */
  private naturalScale(): number | null {
    const { naturalWidth, clientWidth } = this.image;
    return naturalWidth > 0 && clientWidth > 0 ? naturalWidth / clientWidth : null;
  }

  private maxScale(naturalScale: number): number {
    return Math.max(MIN_MAX_ZOOM, naturalScale * MAX_NATURAL_MULTIPLE);
  }

  private stageCenter(): { x: number; y: number } {
    const rect = this.stage.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** Zooms to `scale`, keeping the image point under the client point (default: stage center) fixed. */
  zoomTo(scale: number, clientX?: number, clientY?: number): void {
    const naturalScale = this.naturalScale();
    if (naturalScale === null) return;
    const next = Math.min(Math.max(scale, MIN_ZOOM), this.maxScale(naturalScale));
    const center = this.stageCenter();
    const dx = (clientX ?? center.x) - center.x;
    const dy = (clientY ?? center.y) - center.y;
    const ratio = next / this.scale;
    this.x = dx - (dx - this.x) * ratio;
    this.y = dy - (dy - this.y) * ratio;
    this.scale = next;
    this.render();
  }

  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    this.zoomTo(this.scale * factor, clientX, clientY);
  }

  reset(): void {
    this.zoomTo(1);
  }

  /** Moves the image by the given offset, within the pan limits. */
  panBy(dx: number, dy: number): void {
    if (this.naturalScale() === null) return;
    this.x += dx;
    this.y += dy;
    this.render();
  }

  /** Whether the click that just happened ended a pan; consumes the flag. */
  consumePanClick(): boolean {
    if (this.gesture.phase !== 'panned') return false;
    this.gesture = { phase: 'idle' };
    return true;
  }

  dispose(): void {
    this.endDrag();
    this.ownerDocument.defaultView?.removeEventListener('resize', this.onResize);
  }

  // A new fit size changes the maximum zoom, so re-apply it along with the pan limits.
  private readonly onResize = (): void => this.zoomTo(this.scale);

  private render(): void {
    const naturalScale = this.naturalScale();
    if (naturalScale === null) return;
    // Keep a zoomed image covering the stage; an image smaller than the stage stays centered.
    const rect = this.stage.getBoundingClientRect();
    const limitX = Math.max(0, (this.image.clientWidth * this.scale - rect.width) / 2);
    const limitY = Math.max(0, (this.image.clientHeight * this.scale - rect.height) / 2);
    this.x = Math.min(Math.max(this.x, -limitX), limitX);
    this.y = Math.min(Math.max(this.y, -limitY), limitY);
    this.image.style.transform = this.scale === 1
      ? ''
      : `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    this.stage.toggleClass('is-zoomed', this.scale > 1);
    this.level.setText(t('chat.images.zoomLevel', { percent: String(Math.round(this.scale / naturalScale * 100)) }));
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const lineHeight = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * this.stage.getBoundingClientRect().height
      : event.deltaY * lineHeight;
    this.zoomBy(Math.exp(-delta * (event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE)), event.clientX, event.clientY);
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    const naturalScale = this.naturalScale();
    if (naturalScale === null) return;
    if (this.scale !== 1) {
      this.reset();
      return;
    }
    // An image already shown at its natural size zooms to twice that instead.
    this.zoomTo(naturalScale > 1 ? naturalScale : 2, event.clientX, event.clientY);
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    // A pan released outside the window produces no click, so its `panned` phase ends here.
    this.endDrag();
    if (event.button !== 0 || this.scale <= 1 || event.target !== this.image && event.target !== this.stage) return;
    // Prevent the browser's native image drag and text selection.
    event.preventDefault();
    this.gesture = {
      phase: 'dragging', startX: event.clientX, startY: event.clientY, originX: this.x, originY: this.y, moved: false,
    };
    this.stage.addClass('is-panning');
    this.ownerDocument.addEventListener('mousemove', this.onMouseMove);
    this.ownerDocument.addEventListener('mouseup', this.onMouseUp);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    const drag = this.gesture;
    if (drag.phase !== 'dragging') return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    this.x = drag.originX + dx;
    this.y = drag.originY + dy;
    this.render();
  };

  private readonly onMouseUp = (): void => {
    const panned = this.gesture.phase === 'dragging' && this.gesture.moved;
    this.endDrag();
    if (panned) this.gesture = { phase: 'panned' };
  };

  private endDrag(): void {
    this.gesture = { phase: 'idle' };
    this.stage.removeClass('is-panning');
    this.ownerDocument.removeEventListener('mousemove', this.onMouseMove);
    this.ownerDocument.removeEventListener('mouseup', this.onMouseUp);
  }
}

/** Owns the DOM and focus lifecycle of one open image preview. */
export class ImagePreviewModal {
  private closeCurrent: (() => void) | null = null;

  open(ownerDocument: Document, image: ImagePreviewSource, keymap: Keymap): void {
    this.close();

    const previouslyFocusedElement = getFocusableActiveElement(ownerDocument);
    const overlay = ownerDocument.body.createDiv({ cls: 'claudian-image-modal-overlay' });
    // The dialog is the full-screen stage the image zooms within; its empty area is the backdrop.
    const modal = overlay.createDiv({ cls: 'claudian-image-modal' });
    setModalAccessibility(modal, t('chat.images.preview', { name: image.name }));

    const imageEl = modal.createEl('img', {
      attr: {
        src: image.src,
        alt: image.name,
        draggable: 'false',
      },
    });

    const closeButton = modal.createEl('button', {
      cls: 'claudian-image-modal-close',
      attr: {
        'aria-label': t('chat.images.closePreview'),
        type: 'button',
      },
    });
    // An icon is centered geometrically; a text glyph sits on the font's baseline.
    setIcon(closeButton, 'x');
    const level = modal.createDiv({
      cls: 'claudian-image-modal-zoom',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    const zoom = new ImageZoom(ownerDocument, modal, imageEl, level);

    // A modal scope takes precedence over the view scope in Obsidian's window-capture keymap.
    const scope = new Scope();
    let isClosed = false;
    const close = () => {
      if (isClosed) return;
      isClosed = true;
      zoom.dispose();
      keymap.popScope(scope);
      overlay.remove();
      if (this.closeCurrent === close) {
        this.closeCurrent = null;
      }
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      }
    };
    scope.register(null, 'Escape', () => {
      close();
      return false;
    });
    scope.register(null, 'Tab', () => {
      closeButton.focus();
      return false;
    });
    // Unmodified only, so host shortcuts such as Mod+0 and Mod+= keep working.
    const zoomKeys: Array<[Modifier[], string, () => void]> = [
      [[], '=', () => zoom.zoomBy(KEY_ZOOM_STEP)],
      [[], '+', () => zoom.zoomBy(KEY_ZOOM_STEP)],
      [['Shift'], '+', () => zoom.zoomBy(KEY_ZOOM_STEP)],
      [[], '-', () => zoom.zoomBy(1 / KEY_ZOOM_STEP)],
      [[], '0', () => zoom.reset()],
      // An arrow reveals more of the image in its direction.
      [[], 'ArrowLeft', () => zoom.panBy(KEY_PAN_STEP_PX, 0)],
      [[], 'ArrowRight', () => zoom.panBy(-KEY_PAN_STEP_PX, 0)],
      [[], 'ArrowUp', () => zoom.panBy(0, KEY_PAN_STEP_PX)],
      [[], 'ArrowDown', () => zoom.panBy(0, -KEY_PAN_STEP_PX)],
    ];
    for (const [modifiers, key, action] of zoomKeys) {
      scope.register(modifiers, key, () => {
        action();
        return false;
      });
    }

    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (zoom.consumePanClick()) return;
      if (event.target === overlay || event.target === modal) close();
    });
    keymap.pushScope(scope);
    this.closeCurrent = close;
    closeButton.focus();
  }

  close(): void {
    this.closeCurrent?.();
  }
}
