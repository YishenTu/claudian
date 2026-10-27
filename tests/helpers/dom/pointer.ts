import { createEvent, fireEvent } from '@testing-library/dom';

/** jsdom has no PointerEvent, so the pointer position and primary button are set on the dispatched event. */
export function firePointer(
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  el: Element | Document,
  clientY: number,
): void {
  const event = createEvent[type](el, {});
  Object.defineProperty(event, 'clientY', { value: clientY });
  Object.defineProperty(event, 'button', { value: 0 });
  fireEvent(el, event);
}
