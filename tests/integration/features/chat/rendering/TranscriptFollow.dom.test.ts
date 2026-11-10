/** @vitest-environment jsdom */
import { useTranscriptGeometry } from '@test/helpers/dom/transcriptGeometry';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testDate } from '@test/helpers/testClock';
import { fireEvent } from '@testing-library/dom';
import { Component } from 'obsidian';

import type { ChatMessage } from '@/core/types';
import { type LiveTranscriptOptions, MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  document.body.replaceChildren();
});

function transcript(): ChatMessage[] {
  return Array.from({ length: 6 }, (_, index) => [
    { id: `u${index}`, role: 'user' as const, content: `Prompt ${index}`, timestamp: testDate().getTime() },
    { id: `a${index}`, role: 'assistant' as const, content: `Answer ${index}`, timestamp: testDate().getTime(),
      completedAt: testDate().getTime(), contentBlocks: [{ type: 'text' as const, content: `Answer ${index}` }] },
  ]).flat();
}

/** A transcript whose messages grow by 300px when their late content (an image, a diagram, streamed text) lays out. */
async function createTranscript(autoScroll: boolean, { viewportHeight = 400 } = {}) {
  const messagesEl = document.body.createDiv();
  const plugin = await createChatFeatureHost({ settings: { mediaFolder: '', enableAutoScroll: autoScroll } });
  const renderer = new MessageRenderer(plugin, new Component(), messagesEl);
  cleanups.push(() => renderer.dispose());
  const grown = new Set<string>();
  const geometry = useTranscriptGeometry(messagesEl, {
    viewportHeight, rowHeight: row => 100 + (grown.has(row.dataset.messageId ?? '') ? 300 : 0),
  });
  const grow = (id: string) => { grown.add(id); geometry.layout(); };
  return { messagesEl, renderer, geometry, grow };
}

async function openTranscript(autoScroll: boolean) {
  const opened = await createTranscript(autoScroll);
  opened.renderer.renderMessages(transcript(), () => 'Welcome');
  expect(opened.messagesEl.scrollTop).toBe(opened.geometry.bottom());
  return { ...opened, growLastReply: () => opened.grow('a5') };
}

const liveResponse = (id: string): LiveTranscriptOptions => ({
  isResponseOpen: messageId => messageId === id,
  isSubagentTracked: () => false,
  onToolRendered: () => undefined,
  renderSubagent: () => undefined,
  reservePendingSubagent: () => false,
});

it.each([true, false])('keeps an opened transcript at its end when late content grows (auto-scroll %s)', async autoScroll => {
  const { messagesEl, geometry, growLastReply } = await openTranscript(autoScroll);
  const before = messagesEl.scrollTop;

  growLastReply();

  expect(geometry.bottom()).toBe(before + 300);
  expect(messagesEl.scrollTop).toBe(geometry.bottom());
});

it('leaves a reader who scrolled up in place when late content grows', async () => {
  const { messagesEl, growLastReply } = await openTranscript(true);
  fireEvent.wheel(messagesEl, { deltaY: -100 });
  messagesEl.scrollTop = 200;
  fireEvent.scroll(messagesEl);

  growLastReply();

  expect(messagesEl.scrollTop).toBe(200);
});

it.each([
  { reader: 'at the bottom', top: (bottom: number) => bottom, expected: (bottom: number) => bottom },
  { reader: 'reading further up', top: () => 200, expected: () => 200 },
])('keeps a reader $reader in place when the viewport shrinks', async ({ top, expected }) => {
  const { messagesEl, geometry } = await openTranscript(false);
  fireEvent.wheel(messagesEl, { deltaY: -100 });
  messagesEl.scrollTop = top(geometry.bottom());
  fireEvent.scroll(messagesEl);

  // A multi-line draft grows the composer, taking height from the transcript.
  geometry.resizeViewport(250);

  expect(messagesEl.scrollTop).toBe(expected(geometry.bottom()));
});

it('stops following once its presentation is disposed', async () => {
  const { messagesEl, renderer, geometry } = await openTranscript(true);
  renderer.dispose();
  messagesEl.scrollTop = 0;
  // Content a later owner puts in the released element must not be scrolled by the old one.
  for (let index = 0; index < 10; index++) messagesEl.createDiv({ cls: 'claudian-message' });
  geometry.layout();
  geometry.resizeViewport(300);
  messagesEl.dispatchEvent(new Event('scroll'));

  expect(geometry.bottom()).toBeGreaterThan(0);
  expect(messagesEl.scrollTop).toBe(0);
});

it('does not let a delayed arrival take back a reader who scrolled up after following it', async () => {
  const { messagesEl, renderer, geometry, growLastReply } = await openTranscript(true);
  const captured = messagesEl.scrollTop;
  const followArrival = renderer.follow.holdArrival();
  // Earlier parts of the arrival render and are followed before it finishes.
  growLastReply();
  expect(messagesEl.scrollTop).toBe(geometry.bottom());
  fireEvent.wheel(messagesEl, { deltaY: -100 });
  messagesEl.scrollTop = captured + 100;
  fireEvent.scroll(messagesEl);

  followArrival();

  expect(messagesEl.scrollTop).toBe(captured + 100);
});

it.each([
  { opening: 'a visible transcript with a reply still streaming', hiddenArrival: false },
  { opening: 'a hidden transcript that receives an arrival before it is shown', hiddenArrival: true },
])('lands at the end of $opening, then follows growth only as the setting allows', async ({ hiddenArrival }) => {
  const { messagesEl, renderer, geometry, grow } = await createTranscript(false, { viewportHeight: hiddenArrival ? 0 : 400 });
  const messages = transcript();
  renderer.renderMessages(messages, () => 'Welcome', hiddenArrival ? undefined : liveResponse('a5'));
  if (hiddenArrival) {
    const followArrival = renderer.follow.holdArrival();
    renderer.addMessage({ id: 'late', role: 'assistant', content: '', timestamp: testDate().getTime() });
    followArrival();
  }
  // Layout follows the rendering task, after its mutations have been observed.
  await Promise.resolve();
  if (hiddenArrival) geometry.resizeViewport(400);
  else geometry.layout();
  expect(messagesEl.scrollTop).toBe(geometry.bottom());
  const landed = messagesEl.scrollTop;

  grow(hiddenArrival ? 'late' : 'a5');

  expect(geometry.bottom()).toBe(landed + 300);
  expect(messagesEl.scrollTop).toBe(landed);
});
