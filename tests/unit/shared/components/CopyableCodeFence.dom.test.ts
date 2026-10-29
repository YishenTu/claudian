/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, within } from '@testing-library/dom';

import { bindCopyFeedback } from '@/shared/components/CopyableCodeFence';

it('copies through the clicked control\'s window after it moves into a popout', async () => {
  const frame = document.body.appendChild(document.createElement('iframe'));
  const popoutDocument = frame.contentDocument!;
  const mainWrite = vi.fn().mockRejectedValue(new Error('Document is not focused'));
  const popoutWrite = vi.fn().mockResolvedValue(undefined);
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mainWrite } });
  Object.defineProperty(frame.contentWindow!.navigator, 'clipboard', { configurable: true, value: { writeText: popoutWrite } });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Copy code';
  bindCopyFeedback(button, () => 'const answer = 42;', () => { button.textContent = 'Copied!'; }, () => { button.textContent = 'Copy code'; });
  popoutDocument.body.appendChild(button);
  vi.useFakeTimers();
  try {
    const copy = within(popoutDocument.body).getByRole('button', { name: 'Copy code' });
    fireEvent.click(copy);
    await Promise.resolve();
    expect(popoutWrite).toHaveBeenCalledWith('const answer = 42;');
    expect(mainWrite).not.toHaveBeenCalled();
    expect(within(popoutDocument.body).getByRole('button', { name: 'Copied!' })).toBe(copy);
    vi.advanceTimersByTime(1_500);
    expect(within(popoutDocument.body).getByRole('button', { name: 'Copy code' })).toBe(copy);
    vi.useRealTimers();
    expect((await axe(button)).violations).toEqual([]);
  } finally {
    vi.useRealTimers();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    frame.remove();
  }
});
