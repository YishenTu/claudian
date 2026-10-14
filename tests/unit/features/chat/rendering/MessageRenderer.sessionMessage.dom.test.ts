/** @jest-environment jsdom */
import '@/providers';

import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component, MarkdownRenderer, Notice } from 'obsidian';

import { encodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ChatMessage, Conversation } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

it.each(['live', 'history'])('shows the sender safely in %s and keeps the envelope out of the body', async mode => {
  document.body.replaceChildren();
  const host = document.body.createDiv();
  const records = new Map([['source-session', { id: 'source-session', providerId: 'claude' } as Conversation]]);
  const openConversation = jest.fn(async (_id: string) => undefined);
  const renderer = new MessageRenderer({
    app: {}, settings: { mediaFolder: '' },
    ensureConversationMetadataLoaded: async () => undefined,
    getCachedConversation: (id: string) => records.get(id) ?? null,
    getConversationSummary: (id: string) => records.get(id) ?? null,
  } as any, new Component(), host, undefined, undefined, undefined, undefined, openConversation);
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    el.textContent = markdown;
  });
  const sender = { from: '<img src=x onerror=alert(1)> & Research', sessionId: 'source-session' };
  const message: ChatMessage = {
    id: 'incoming', role: 'user', timestamp: testDate().getTime(),
    content: encodeSessionMessage({ ...sender, text: 'Please check the results.' }),
    sessionMessage: sender,
  };
  const ordinary: ChatMessage = {
    id: 'ordinary', role: 'user', timestamp: testDate().getTime(), content: 'My own prompt.',
  };
  try {
    if (mode === 'live') {
      renderer.addMessage(message);
      renderer.addMessage(ordinary);
    } else {
      renderer.renderMessages([message, ordinary], () => 'Hello');
    }
    await Promise.resolve();
    // Only the session name is the link (and so the only underlined text); the label sits outside it.
    const badge = within(host).getByRole('button', { name: sender.from });
    expect(badge.textContent).toBe(sender.from);
    const senderLine = badge.closest<HTMLElement>('.claudian-session-message-sender')!;
    expect(within(senderLine).getByText('From session:').closest('button')).toBeNull();
    expect(badge.getAttribute('type')).toBe('button');
    expect(badge.getAttribute('title')).toBe('Open Claude Code session source-session');
    expect(badge.querySelector('img')).toBeNull();
    expect(within(host).getByText('Please check the results.')).toBeTruthy();
    expect(host.textContent).not.toContain('<session_message');
    expect(within(host).getByText('My own prompt.')).toBeTruthy();
    expect(host.querySelector('[data-message-id="ordinary"] .claudian-session-message-sender')).toBeNull();
    expect((await axe(host)).violations).toEqual([]);
    fireEvent.click(badge);
    await waitFor(() => expect(openConversation).toHaveBeenCalledWith('source-session'));

    // A deleted sender is reported, not opened; its badge no longer names a provider.
    records.delete('source-session');
    renderer.addMessage({ ...message, id: 'incoming-again' });
    const stale = within(host.querySelector<HTMLElement>('[data-message-id="incoming-again"]')!).getByRole('button', { name: sender.from });
    expect(stale.getAttribute('title')).toBe('Open session source-session');
    jest.mocked(Notice).mockClear();
    fireEvent.click(stale);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('That session no longer exists.'));
    expect(openConversation).toHaveBeenCalledTimes(1);
  } finally {
    renderer.dispose();
  }
});
