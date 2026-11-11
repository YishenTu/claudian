/** @vitest-environment jsdom */
import '@/providers';

import { useTranscriptGeometry } from '@test/helpers/dom/transcriptGeometry';
import { createHarness, releaseSideChatHarnesses, startSideChat } from '@test/helpers/features/chat/SideChatDOMHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';
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

it('follows a streaming side-chat reply at the bottom and stops following once the reader scrolls up', async () => {
  const harness = await createHarness({ settings: { enableAutoScroll: true } });
  const { started } = await startSideChat(harness);
  harness.backend.latest.establishChild('side-session');
  const runtime = harness.controller.runtime!;
  const messagesEl = harness.composerEl.querySelector<HTMLElement>('.claudian-side-chat-messages')!;
  const geometry = useTranscriptGeometry(messagesEl, { rowHeight: row => 100 + (row.textContent?.length ?? 0) * 10 });
  // A streamed snapshot shows once its throttled Markdown render lands; the browser then lays it out.
  const streamed = async (text: string) => {
    harness.backend.latest.emitText(text);
    await waitFor(() => expect(vi.mocked(MarkdownRenderer.render).mock.calls.some(([, markdown]) => markdown.includes(text.trim()))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    geometry.layout();
  };

  await streamed('First part of a reply long enough to overflow the side chat.');
  await waitFor(() => expect(messagesEl.scrollTop).toBe(geometry.bottom()));
  expect(geometry.bottom()).toBeGreaterThan(0);

  fireEvent.wheel(messagesEl, { deltaY: -100 });
  messagesEl.scrollTop = 0;
  fireEvent.scroll(messagesEl);
  await streamed(' A second part the reader has not reached yet.');
  // Longer than a follow frame: a paused reader must not be moved by it.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(within(messagesEl).getByText(runtime.state.lastMessage!.content)).toBeTruthy();
  expect(messagesEl.scrollTop).toBe(0);

  harness.backend.latest.complete();
  await started;
});
