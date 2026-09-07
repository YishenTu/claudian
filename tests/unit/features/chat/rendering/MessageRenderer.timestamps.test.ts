/** @jest-environment jsdom */

import '@/providers';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId } from '@/core/providers/types';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

// Obsidian extends native DOM elements with these helpers.
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };

const providers: ProviderId[] = ['claude', 'codex', 'grok', 'opencode', 'pi'];
const timestamp = 1786528800000;

function createRenderer(providerId: ProviderId, enabled = true) {
  const messagesEl = document.createElement('div');
  const settings = { mediaFolder: '', showMessageTimestamps: enabled };
  const component = { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() };
  const renderer = new MessageRenderer(
    { app: {}, settings } as any,
    component as any,
    messagesEl,
    undefined,
    undefined,
    () => ProviderRegistry.getCapabilities(providerId),
  );
  return { renderer, messagesEl, settings };
}

describe.each(providers)('%s message timestamps', (providerId) => {
  it.each(['addMessage', 'renderStoredMessage'] as const)('%s timestamps text and image-only messages', (method) => {
    const { renderer, messagesEl } = createRenderer(providerId);
    const messages: ChatMessage[] = [
      { id: 'user', role: 'user', content: 'Hello', timestamp },
      { id: 'assistant', role: 'assistant', content: 'Reply', timestamp },
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

describe('message timestamp refresh', () => {
  it('updates existing messages without replacing streaming content or duplicating stamps', () => {
    const { renderer, messagesEl, settings } = createRenderer('claude', false);
    const msg: ChatMessage = { id: 'assistant', role: 'assistant', content: '', timestamp };
    const messageEl = renderer.addMessage(msg);
    const contentEl = messageEl.querySelector('.claudian-message-content')!;
    contentEl.createDiv({ text: 'Partial reply' });
    expect(messagesEl.querySelectorAll('.claudian-message-timestamp').length).toBe(0);

    settings.showMessageTimestamps = true;
    renderer.refreshMessageTimestamps();
    renderer.refreshMessageTimestamps();
    expect(messagesEl.querySelectorAll('.claudian-message-timestamp').length).toBe(1);
    expect(messageEl.querySelector('.claudian-message-content')).toBe(contentEl);
    expect(contentEl.children[0].textContent).toBe('Partial reply');

    settings.showMessageTimestamps = false;
    renderer.refreshMessageTimestamps();
    expect(messagesEl.querySelectorAll('.claudian-message-timestamp').length).toBe(0);
    renderer.dispose();
  });

  it('removes a stale timestamp when updating a live user message after disabling', () => {
    const { renderer, messagesEl, settings } = createRenderer('codex');
    const msg: ChatMessage = { id: 'user', role: 'user', content: 'Hello', timestamp };
    renderer.addMessage(msg);
    settings.showMessageTimestamps = false;
    renderer.updateLiveUserMessage(msg);
    expect(messagesEl.querySelectorAll('.claudian-message-timestamp').length).toBe(0);
    renderer.dispose();
  });
});
