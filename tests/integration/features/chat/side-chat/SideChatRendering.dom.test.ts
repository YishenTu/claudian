/** @vitest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { waitFor, within } from '@testing-library/dom';
import { MarkdownRenderer } from 'obsidian';
import type { Mock } from 'vitest';



afterEach(releaseSideChatHarnesses);

it('defers hidden side-chat Markdown, catches up when visible, and releases viewport observation', async () => {
  const original = window.IntersectionObserver;
  const observers: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnect: Mock }> = [];
  window.IntersectionObserver = vi.fn(function (callback: IntersectionObserverCallback) {
    const observer = { callback, target: undefined as Element | undefined, disconnect: vi.fn() };
    observers.push(observer);
    return { observe: (target: Element) => { observer.target = target; }, disconnect: observer.disconnect };
  }) as unknown as typeof IntersectionObserver;
  const visible = (isIntersecting: boolean) => {
    for (const observer of observers) observer.callback([{ isIntersecting, target: observer.target } as IntersectionObserverEntry], {} as IntersectionObserver);
  };
  try {
    const harness = await createHarness();
    const { started } = await startSideChat(harness);
    harness.backend.latest.establishChild('side-session');
    const runtime = harness.controller.runtime!;
    const messagesEl = harness.composerEl.querySelector<HTMLElement>('.claudian-side-chat-messages')!;
    vi.mocked(MarkdownRenderer.render).mockClear();
    const renderedMarkdown = () => vi.mocked(MarkdownRenderer.render).mock.calls
      .filter(([, , element]) => messagesEl.contains(element)).map(([, text]) => text);
    harness.controller.collapse();
    visible(false);
    harness.backend.latest.emitText('Hidden output');
    await waitFor(() => expect(runtime.state.lastMessage?.content).toBe('Hidden output'));
    // Longer than the initial render frame: a hidden snapshot must not reach MarkdownRenderer.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(renderedMarkdown()).toEqual([]);
    expect(harness.controller.destination).toBe('main');

    visible(true);
    await waitFor(() => expect(within(messagesEl).getByText('Hidden output')).toBeTruthy());
    visible(false);
    harness.backend.latest.emitText(' and final output');
    harness.backend.latest.complete();
    await started;
    expect(runtime.state.lastMessage?.content).toBe('Hidden output and final output');
    expect(within(messagesEl).getByText('Hidden output and final output')).toBeTruthy();
    await harness.controller.discard();
    const sideObservers = observers.filter(observer => observer.target?.classList.contains('claudian-side-chat-messages'));
    expect(sideObservers).toHaveLength(1);
    expect(sideObservers[0].disconnect).toHaveBeenCalledTimes(1);
  } finally {
    window.IntersectionObserver = original;
  }
});
