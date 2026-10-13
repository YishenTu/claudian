/** @jest-environment jsdom */

import { testDate } from '@test/helpers/testClock';
import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component, MarkdownRenderer } from 'obsidian';

import { encodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

it.each(['live', 'history'])('shows the sender safely in %s and keeps the envelope out of the body', async mode => {
  document.body.replaceChildren();
  const host = document.body.createDiv();
  const renderer = new MessageRenderer({ app: {}, settings: { mediaFolder: '' } } as any, new Component(), host);
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
    const badge = within(host).getByText(`From ${sender.from}`);
    expect(badge.getAttribute('title')).toBe('Session: source-session');
    expect(badge.querySelector('img')).toBeNull();
    expect(within(host).getByText('Please check the results.')).toBeTruthy();
    expect(host.textContent).not.toContain('<session_message');
    expect(within(host).getByText('My own prompt.')).toBeTruthy();
    expect(host.querySelector('[data-message-id="ordinary"] .claudian-session-message-sender')).toBeNull();
    expect((await axe(host)).violations).toEqual([]);
  } finally {
    renderer.dispose();
  }
});
