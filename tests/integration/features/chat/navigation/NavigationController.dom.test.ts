/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, within } from '@testing-library/dom';

import { NavigationController } from '@/features/chat/navigation/NavigationController';

Object.assign(HTMLElement.prototype, {
  addClass(this: HTMLElement, name: string) { this.classList.add(name); },
  removeClass(this: HTMLElement, name: string) { this.classList.remove(name); },
});

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it('stops held-key scrolling when its window blurs and waits for another keydown', async () => {
  const host = document.body.appendChild(document.createElement('div'));
  const messages = host.appendChild(document.createElement('div'));
  messages.setAttribute('role', 'region');
  messages.setAttribute('aria-label', 'Conversation transcript');
  const input = host.appendChild(document.createElement('textarea'));
  input.setAttribute('aria-label', 'Message');
  const other = document.body.appendChild(document.createElement('iframe'));
  other.title = 'Other window';
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback); return frameId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  const advanceFrame = () => {
    const pending = [...frames.values()]; frames.clear();
    for (const frame of pending) frame(performance.now());
  };
  const addListener = vi.spyOn(window, 'addEventListener');
  const removeListener = vi.spyOn(window, 'removeEventListener');
  const controller = new NavigationController({ getMessagesEl: () => messages, getInputEl: () => input,
    getSettings: () => ({ scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' }), isStreaming: () => false });
  try {
    controller.initialize();
    input.focus();
    fireEvent.keyDown(within(host).getByRole('textbox', { name: 'Message' }), { key: 'Escape' });
    expect(document.activeElement).toBe(within(host).getByRole('region', { name: 'Conversation transcript' }));
    messages.scrollTop = 100;
    fireEvent.keyDown(messages, { key: 's' });
    expect(messages.scrollTop).toBeGreaterThan(100);
    const scrolling = messages.scrollTop;
    other.contentWindow!.dispatchEvent(new Event('blur'));
    advanceFrame();
    expect(messages.scrollTop).toBeGreaterThan(scrolling);
    window.dispatchEvent(new Event('blur'));
    const stopped = messages.scrollTop;
    advanceFrame(); advanceFrame();
    expect(messages.scrollTop).toBe(stopped);
    window.dispatchEvent(new Event('focus'));
    advanceFrame();
    expect(messages.scrollTop).toBe(stopped);
    fireEvent.keyDown(messages, { key: 's' });
    advanceFrame();
    expect(messages.scrollTop).toBeGreaterThan(stopped);
    const beforeRelease = messages.scrollTop;
    fireEvent.keyUp(document, { key: 's' });
    advanceFrame();
    expect(messages.scrollTop).toBe(beforeRelease);
    expect(await axe(host)).toHaveNoViolations();
    controller.dispose();
    const blurHandler = addListener.mock.calls.find(([type]) => type === 'blur')?.[1];
    expect(removeListener).toHaveBeenCalledWith('blur', blurHandler);
    fireEvent.keyDown(messages, { key: 's' });
    advanceFrame();
    expect(messages.scrollTop).toBe(beforeRelease);
  } finally { controller.dispose(); }
});
