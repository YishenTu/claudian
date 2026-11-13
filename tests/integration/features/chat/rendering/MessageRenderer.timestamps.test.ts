/** @vitest-environment jsdom */
import '@/providers';

import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testDate } from '@test/helpers/testClock';
import { Component } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

const providers: ProviderId[] = ['claude', 'codex', 'grok', 'opencode', 'pi'];
const timestamp = testDate().getTime();

async function createRenderer(providerId: ProviderId) {
  const messagesEl = document.createElement('div');
  const plugin = await createChatFeatureHost({ settings: { mediaFolder: '' } });
  const component = new Component();
  const renderer = new MessageRenderer(
    plugin,
    component,
    messagesEl,
    undefined,
    undefined,
    () => ProviderRegistry.getCapabilities(providerId),
  );
  return { renderer, messagesEl };
}

describe.each(providers)('%s message timestamps', (providerId) => {
  it.each(['addMessage', 'renderStoredMessage'] as const)('%s timestamps text and image-only messages', async (method) => {
    const { renderer, messagesEl } = (await createRenderer(providerId));
    const messages: ChatMessage[] = [
      { id: 'user', role: 'user', content: 'Hello', timestamp },
      { id: 'assistant', role: 'assistant', content: 'Reply', timestamp, completedAt: timestamp },
      {
        id: 'image', role: 'user', content: '', timestamp,
        images: [{ id: 'img', name: 'photo.png', mediaType: 'image/png', data: 'abc', size: 3, source: 'paste' }],
      },
    ];
    for (const message of messages) renderer[method](message);

    expect(messagesEl.querySelectorAll('.claudian-message-timestamp')).toHaveLength(3);
    expect(messagesEl.querySelector('.claudian-message-images')?.querySelector('.claudian-message-timestamp')).not.toBeNull();
    renderer.dispose();
  });
});

describe('assistant message timestamps', () => {
  it.each(['addMessage', 'renderStoredMessage'] as const)('%s shows a timestamp only once a completion time exists', async (method) => {
    const { renderer, messagesEl } = (await createRenderer('claude'));
    const msg: ChatMessage = { id: 'assistant', role: 'assistant', content: 'Final reply', timestamp };
    renderer[method](msg);
    expect(messagesEl.querySelectorAll('.claudian-message-timestamp').length).toBe(0);

    msg.completedAt = testDate().setHours(14, 35, 0, 0);
    renderer.finalizeResponse(msg, [msg]);
    expect(messagesEl.querySelectorAll('.claudian-message-timestamp')).toHaveLength(1);
    expect(messagesEl.querySelector('.claudian-message-timestamp')?.textContent).toBe('14:35');
    renderer.dispose();
  });
});

it.each([
  [13, '13:05'],
  [0, '00:05'],
])('renders hour %s in 24-hour format', async (hour, expected) => {
  const { renderer, messagesEl } = (await createRenderer('claude'));
  renderer.addMessage({
    id: 'clock', role: 'user', content: 'Hello',
    timestamp: testDate().setHours(hour, 5, 0, 0),
  });
  expect(messagesEl.querySelector('.claudian-message-timestamp')?.textContent).toBe(expected);
  renderer.dispose();
});
