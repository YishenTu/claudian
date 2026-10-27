/** @jest-environment jsdom */
import '@/providers';

import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { waitFor } from '@testing-library/dom';

afterEach(releaseSideChatHarnesses);

it('defers hidden side-chat Markdown, catches up when visible, and releases viewport observation', async () => {
  const original = window.IntersectionObserver;
  const observers: Array<{ callback: IntersectionObserverCallback; target?: Element; disconnect: jest.Mock }> = [];
  window.IntersectionObserver = jest.fn((callback: IntersectionObserverCallback) => {
    const observer = { callback, target: undefined as Element | undefined, disconnect: jest.fn() };
    observers.push(observer);
    return { observe: (target: Element) => { observer.target = target; }, disconnect: observer.disconnect };
  }) as unknown as typeof IntersectionObserver;
  const visible = (isIntersecting: boolean) => {
    for (const observer of observers) observer.callback([{ isIntersecting, target: observer.target } as IntersectionObserverEntry], {} as IntersectionObserver);
  };
  try {
    const harness = createHarness();
    const { started } = await startSideChat(harness);
    harness.backend.latest.establishChild('side-session');
    const runtime = harness.controller.runtime!;
    const render = jest.spyOn(runtime.renderer!, 'renderContent');
    harness.controller.collapse();
    visible(false);
    harness.backend.latest.emitText('Hidden output');
    await waitFor(() => expect(runtime.state.lastMessage?.content).toBe('Hidden output'));
    // Longer than the initial render frame: a hidden snapshot must not reach MarkdownRenderer.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(render).not.toHaveBeenCalled();
    expect(harness.controller.destination).toBe('main');

    visible(true);
    await waitFor(() => expect(render).toHaveBeenCalledWith(expect.anything(), 'Hidden output', { deferMath: true, deferDiagrams: true }));
    visible(false);
    harness.backend.latest.emitText(' and final output');
    harness.backend.latest.complete();
    await started;
    expect(runtime.state.lastMessage?.content).toBe('Hidden output and final output');
    expect(render).toHaveBeenLastCalledWith(expect.anything(), 'Hidden output and final output', { deferMath: true, deferDiagrams: true });
    await harness.controller.discard();
    expect(observers).toHaveLength(1);
    expect(observers[0].target?.classList.contains('claudian-side-chat-messages')).toBe(true);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  } finally {
    window.IntersectionObserver = original;
  }
});
