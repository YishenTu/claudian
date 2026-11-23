/** @vitest-environment jsdom */
import { fireEvent, screen, within } from '@testing-library/dom';
import { App } from 'obsidian';

import { ImagePreviewModal, type ImagePreviewSource } from '@/shared/modals/ImagePreviewModal';

const IMAGE: ImagePreviewSource = { src: 'app://local/Media/diagram.png', name: 'diagram.png' };

function createDocumentHarness() {
  const previouslyFocusedElement = document.body.createEl('button');
  previouslyFocusedElement.focus();
  const previousFocus = vi.spyOn(previouslyFocusedElement, 'focus');
  const keymap = new App().keymap;
  return { keymap, ownerDocument: document, previouslyFocusedElement, previousFocus };
}

/**
 * jsdom has no layout or image decoding. Supply the browser's geometry: a 400×300 stage, the
 * image laid out at a 400×300 fit size, and a 1600×1200 natural size, so fit is 25%.
 */
function openLoaded(modal = new ImagePreviewModal()) {
  const harness = createDocumentHarness();
  modal.open(harness.ownerDocument, IMAGE, harness.keymap);
  const dialog = screen.getByRole('dialog', { name: 'Image preview: diagram.png' });
  const image = within(dialog).getByRole('img', { name: 'diagram.png' });
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 300 }));
  for (const [key, value] of Object.entries({ clientWidth: 400, clientHeight: 300, naturalWidth: 1600, naturalHeight: 1200 })) {
    Object.defineProperty(image, key, { configurable: true, value });
  }
  image.dispatchEvent(new Event('load'));
  const closeButton = within(dialog).getByRole('button', { name: 'Close image preview' });
  return { ...harness, modal, dialog, image, closeButton };
}

/** Where the image is drawn: its translation from the centered fit position, and its scale over fit. */
function placement(image: HTMLElement) {
  const match = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)$/.exec(image.style.transform);
  if (!match) return { x: 0, y: 0, scale: 1 };
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

function zoomLevel(dialog: HTMLElement): string | null {
  return within(dialog).getByRole('status').textContent;
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ImagePreviewModal', () => {
  it('shows a resource URL image', () => {
    const { dialog, image } = openLoaded();

    expect(image.getAttribute('src')).toBe(IMAGE.src);
    expect(zoomLevel(dialog)).toBe('25%');
  });

  it('closes idempotently, releases its scope, and restores connected focus', () => {
    const harness = createDocumentHarness();
    const { previousFocus } = harness;
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);
    const removeOverlay = vi.spyOn(screen.getByRole('dialog').parentElement!, 'remove');

    modal.close();
    modal.close();

    expect(removeOverlay).toHaveBeenCalledTimes(1);
    expect(harness.keymap.popScope).toHaveBeenCalledTimes(1);
    expect(harness.keymap.popScope).toHaveBeenCalledWith(vi.mocked(harness.keymap.pushScope).mock.calls[0][0]);
    expect(previousFocus).toHaveBeenCalledTimes(1);
  });

  it('ignores an active element without a focus operation', () => {
    const harness = createDocumentHarness();
    // Deliberately malformed host input retains the compatibility guard.
    Object.defineProperty(harness.previouslyFocusedElement, 'focus', { value: undefined });
    const modal = new ImagePreviewModal();
    modal.open(harness.ownerDocument, IMAGE, harness.keymap);

    expect(() => modal.close()).not.toThrow();
  });

  it('ignores zoom input until the image has loaded', () => {
    const harness = createDocumentHarness();
    new ImagePreviewModal().open(harness.ownerDocument, IMAGE, harness.keymap);
    const dialog = screen.getByRole('dialog');
    const image = within(dialog).getByRole('img');

    fireEvent.wheel(image, { deltaY: -100, clientX: 300, clientY: 200 });
    press(within(dialog).getByRole('button'), '=');

    expect(image.style.transform).toBe('');
    expect(zoomLevel(dialog)).toBe('');
  });

  it('zooms around the cursor with the wheel or a pinch, between a quarter of fit and its maximum', () => {
    const { dialog, image } = openLoaded();

    // A pinch arrives as a ctrl wheel; this delta doubles the scale at 300,200 (100,50 off center).
    const pinch = fireEvent.wheel(image, { deltaY: -100 * Math.LN2, ctrlKey: true, clientX: 300, clientY: 200 });

    expect(pinch).toBe(false);
    const zoomed = placement(image);
    expect(zoomed.scale).toBeCloseTo(2);
    // The image point under the cursor stays under it: 100 = x + 2 * (100 - x) / 1.
    expect(zoomed.x).toBeCloseTo(-100);
    expect(zoomed.y).toBeCloseTo(-50);
    expect(zoomLevel(dialog)).toBe('50%');

    // Zooming out may shrink the image to a quarter of its fit size, centered.
    fireEvent.wheel(image, { deltaY: 100_000, clientX: 300, clientY: 200 });
    expect(placement(image)).toEqual({ x: 0, y: 0, scale: 0.25 });
    expect(zoomLevel(dialog)).toBe('6%');

    // At most 4× the natural size (16× fit here), and the zoomed image keeps covering the stage.
    fireEvent.wheel(image, { deltaY: -100_000, clientX: 0, clientY: 0 });
    const maximum = placement(image);
    expect(maximum.scale).toBeCloseTo(16);
    expect(maximum.x).toBeCloseTo((400 * 16 - 400) / 2);
    expect(maximum.y).toBeCloseTo((300 * 16 - 300) / 2);
    expect(zoomLevel(dialog)).toBe('400%');
  });

  it('zooms from the keyboard and leaves modified shortcuts to the host', () => {
    const { dialog, image, closeButton } = openLoaded();

    expect(press(closeButton, '=').defaultPrevented).toBe(true);
    expect(placement(image).scale).toBeCloseTo(1.25);
    press(closeButton, '+', { shiftKey: true });
    expect(placement(image).scale).toBeCloseTo(1.5625);
    press(closeButton, '+');
    expect(placement(image).scale).toBeCloseTo(1.953125);
    press(closeButton, '-');
    expect(placement(image).scale).toBeCloseTo(1.5625);
    expect(zoomLevel(dialog)).toBe('39%');
    expect(placement(image).x).toBe(0);

    expect(press(closeButton, '0', { metaKey: true }).defaultPrevented).toBe(false);
    expect(placement(image).scale).toBeCloseTo(1.5625);
    press(closeButton, '0');
    expect(placement(image)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(zoomLevel(dialog)).toBe('25%');
    press(closeButton, '-');
    expect(placement(image).scale).toBeCloseTo(0.8);
    expect(zoomLevel(dialog)).toBe('20%');
  });

  it('toggles between fit and the natural size on double-click', () => {
    const { dialog, image } = openLoaded();

    fireEvent.dblClick(image, { clientX: 200, clientY: 150 });
    expect(placement(image).scale).toBeCloseTo(4);
    expect(zoomLevel(dialog)).toBe('100%');

    fireEvent.dblClick(image, { clientX: 300, clientY: 200 });
    expect(placement(image)).toEqual({ x: 0, y: 0, scale: 1 });

    // From below fit, double-click returns to fit.
    fireEvent.wheel(image, { deltaY: 100_000, clientX: 200, clientY: 150 });
    fireEvent.dblClick(image, { clientX: 200, clientY: 150 });
    expect(placement(image)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('pans a zoomed image by dragging without closing when the drag ends over the backdrop', () => {
    const { dialog, image } = openLoaded();
    fireEvent.dblClick(image, { clientX: 200, clientY: 150 });

    expect(fireEvent.mouseDown(image, { button: 0, clientX: 200, clientY: 150 })).toBe(false);
    fireEvent.mouseMove(document, { clientX: 150, clientY: 130 });
    fireEvent.mouseUp(document, { clientX: 150, clientY: 130 });
    // The browser targets the click at the common ancestor of the press and the release.
    fireEvent.click(dialog, { clientX: 150, clientY: 130 });

    expect(placement(image)).toEqual({ x: -50, y: -20, scale: 4 });
    expect(screen.getByRole('dialog')).toBe(dialog);

    // Releasing the drag stops panning.
    fireEvent.mouseMove(document, { clientX: 0, clientY: 0 });
    expect(placement(image)).toEqual({ x: -50, y: -20, scale: 4 });

    // A click on the backdrop without a drag still dismisses.
    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops panning at the edges of a zoomed image', () => {
    const { image } = openLoaded();
    fireEvent.dblClick(image, { clientX: 200, clientY: 150 });

    // At 4× a 400×300 fit size in a 400×300 stage, the center may move ±(1600 - 400) / 2 by ±(1200 - 300) / 2.
    fireEvent.mouseDown(image, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 5200, clientY: 5150 });
    expect(placement(image)).toEqual({ x: 600, y: 450, scale: 4 });
    fireEvent.mouseMove(document, { clientX: -4800, clientY: -4850 });
    expect(placement(image)).toEqual({ x: -600, y: -450, scale: 4 });
    fireEvent.mouseUp(document);
  });

  it('keeps a zoomed image on screen and its level current when the window resizes', () => {
    const { dialog, image } = openLoaded();
    fireEvent.dblClick(image, { clientX: 200, clientY: 150 });
    fireEvent.mouseDown(image, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: -4800, clientY: -4850 });
    fireEvent.mouseUp(document);

    // The window halves: CSS refits the image to 200×150 inside a 200×150 stage.
    vi.mocked(dialog.getBoundingClientRect).mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 150 }));
    Object.defineProperty(image, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(image, 'clientHeight', { configurable: true, value: 150 });
    window.dispatchEvent(new Event('resize'));

    expect(placement(image)).toEqual({ x: -300, y: -225, scale: 4 });
    expect(zoomLevel(dialog)).toBe('50%');
  });

  it.each([['at', 0], ['below', 100_000]] as const)('does not pan an image %s fit size', (_, zoomOut) => {
    const { dialog, image } = openLoaded();
    if (zoomOut) fireEvent.wheel(image, { deltaY: zoomOut, clientX: 200, clientY: 150 });
    const before = placement(image);

    fireEvent.mouseDown(image, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 150, clientY: 130 });
    fireEvent.mouseUp(document, { clientX: 150, clientY: 130 });

    expect(placement(image)).toEqual({ ...before, x: 0, y: 0 });
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('stops following the pointer once closed mid-drag', () => {
    const { modal, image } = openLoaded();
    fireEvent.dblClick(image, { clientX: 200, clientY: 150 });
    fireEvent.mouseDown(image, { button: 0, clientX: 200, clientY: 150 });
    const removeListener = vi.spyOn(document, 'removeEventListener');

    modal.close();

    const removed = removeListener.mock.calls.map(([type]) => type);
    expect(removed).toEqual(expect.arrayContaining(['mousemove', 'mouseup']));
  });

  it('stops following window resizes once closed', () => {
    const { modal, dialog, image } = openLoaded();
    modal.close();
    const measure = vi.mocked(dialog.getBoundingClientRect);
    measure.mockClear();

    window.dispatchEvent(new Event('resize'));

    expect(measure).not.toHaveBeenCalled();
    expect(image.isConnected).toBe(false);
  });
});
