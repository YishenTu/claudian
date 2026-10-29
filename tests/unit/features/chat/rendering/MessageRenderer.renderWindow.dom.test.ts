/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createConversationPorts } from '@test/helpers/ConversationPorts';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { Component, MarkdownRenderer } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ChatMessage } from '@/core/types';
import { ConversationController } from '@/features/chat/conversation/ConversationController';
import { NavigationSidebar } from '@/features/chat/navigation/NavigationSidebar';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { ChatState } from '@/features/chat/state/ChatState';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.appendText = function (text) { this.append(document.createTextNode(text)); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

const start = testDate().getTime();

function turn(index: number): ChatMessage[] {
  return [
    { id: `u${index}`, role: 'user', content: `Prompt ${index}`, timestamp: start + index },
    { id: `a${index}`, role: 'assistant', content: `Answer ${index}`, timestamp: start + index,
      durationSeconds: 1, completedAt: start + index, contentBlocks: [{ type: 'text', content: `Answer ${index}` }] },
  ];
}

/** 102 messages whose tail window would begin at a bare interrupt marker if cut by count alone. */
function transcript(): ChatMessage[] {
  const messages = Array.from({ length: 30 }, (_, index) => turn(index)).flat();
  messages.push(
    { id: 'u-stopped', role: 'user', content: 'Stopped prompt', timestamp: start + 30 },
    { id: 'a-stopped', role: 'assistant', content: 'Partial', timestamp: start + 30,
      contentBlocks: [{ type: 'text', content: 'Partial' }] },
    { id: 'marker', role: 'user', content: '[Request interrupted by user]', timestamp: start + 30, isInterrupt: true },
  );
  for (let index = 31; index < 50; index++) messages.push(...turn(index));
  messages.push({ id: 'u-last', role: 'user', content: 'Last prompt', timestamp: start + 50 });
  return messages;
}

function setup(providerId?: string, navigate: (id: string, target?: string) => Promise<void> = vi.fn()) {
  const messagesEl = document.body.createDiv();
  // jsdom has no layout: a 500px viewport over top-level nodes 100px tall each.
  let scrollTop = 0;
  Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, get: () => messagesEl.children.length * 100 });
  Object.defineProperty(messagesEl, 'scrollTop', { configurable: true, get: () => scrollTop, set: value => { scrollTop = value; } });
  Object.defineProperty(messagesEl, 'clientHeight', { configurable: true, get: () => 500 });
  messagesEl.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = Array.from(messagesEl.children).indexOf(this) * 100 - scrollTop;
    return { top, bottom: top + 100 } as DOMRect;
  });
  const renderer = new MessageRenderer(
    { app: {}, settings: { mediaFolder: '' } } as any, new Component() as any, messagesEl, undefined, undefined,
    providerId ? () => ProviderRegistry.getCapabilities(providerId) : undefined,
    { navigate, isBusy: () => false },
  );
  return { renderer, messagesEl };
}

function renderedPrompts(messagesEl: HTMLElement): string[] {
  return Array.from(messagesEl.querySelectorAll<HTMLElement>('[data-role="user"]'), el => el.textContent ?? '');
}

afterEach(() => { vi.restoreAllMocks(); });

beforeEach(() => {
  document.body.replaceChildren();
  vi.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, el) => {
    (el as HTMLElement).createEl('p', { text: markdown });
  });
});

it('renders the latest turns first and reveals earlier turns above them in order, keeping the reading position', async () => {
  const { renderer, messagesEl } = setup();
  const messages = transcript();
  renderer.renderMessages(messages, () => 'Hello');

  // The window starts at the stopped turn's prompt, never at its bare marker.
  expect(renderedPrompts(messagesEl)[0]).toBe('Stopped prompt');
  expect(renderedPrompts(messagesEl)).not.toContain('Prompt 29');
  expect(Array.from(messagesEl.querySelectorAll('.claudian-message')).filter(el => !el.hasAttribute('data-message-id'))).toEqual([]);
  expect(messagesEl.querySelector('[data-message-id="a-stopped"]')?.textContent).toContain('Interrupted');

  const showEarlier = within(messagesEl).getByRole('button', { name: 'Show earlier messages' });
  expect(await axe(messagesEl)).toHaveNoViolations();
  const firstShown = messagesEl.querySelector<HTMLElement>('[data-message-id="u-stopped"]')!;
  const nodesBefore = messagesEl.children.length;
  messagesEl.scrollTop = 0;
  fireEvent.click(showEarlier);

  expect(renderedPrompts(messagesEl).slice(0, 2)).toEqual(['Prompt 10', 'Prompt 11']);
  // The prompt that was on screen stays where the reader left it.
  expect(messagesEl.scrollTop).toBe((messagesEl.children.length - nodesBefore) * 100);
  expect(messagesEl.querySelector('[data-message-id="u-stopped"]')).toBe(firstShown);

  const lastShowEarlier = within(messagesEl).getByRole('button', { name: 'Show earlier messages' });
  lastShowEarlier.focus();
  fireEvent.click(lastShowEarlier);
  expect(within(messagesEl).queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
  // Keyboard focus stays in the transcript when the last reveal removes the focused control.
  expect(document.activeElement).toBe(messagesEl);
  const visiblePrompts = messages.filter(message => message.role === 'user' && !message.isInterrupt).map(message => message.content);
  expect(renderedPrompts(messagesEl)).toEqual(visiblePrompts);
  expect(Array.from(messagesEl.querySelectorAll('[data-role="assistant"]'), el => el.getAttribute('data-message-id')))
    .toEqual(messages.filter(message => message.role === 'assistant').map(message => message.id));
});

it('renders a short transcript whole without an earlier-messages control', () => {
  const { renderer, messagesEl } = setup();
  const messages = Array.from({ length: 5 }, (_, index) => turn(index)).flat();
  renderer.renderMessages(messages, () => 'Hello');
  expect(renderedPrompts(messagesEl)).toHaveLength(5);
  expect(within(messagesEl).queryByRole('button', { name: 'Show earlier messages' })).toBeNull();
});

it('lists every prompt without rendering earlier bodies and reveals only through the selected prompt', () => {
  const { renderer, messagesEl } = setup();
  const parent = document.body.createDiv();
  parent.append(messagesEl);
  messagesEl.scrollTo = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return Array.from(messagesEl.children).indexOf(this) * 100;
  });
  const messages = Array.from({ length: 60 }, (_, index) => turn(index)).flat();
  messages[20].displayContent = 'Visible prompt ten';
  renderer.renderMessages(messages, () => 'Hello');
  const sidebar = new NavigationSidebar(parent, messagesEl, () => renderer.getDirectoryEntries());
  try {
    const rendersBefore = vi.mocked(MarkdownRenderer.render).mock.calls.length;
    fireEvent.click(within(parent).getByRole('button', { name: 'Conversation directory' }));
    expect(within(parent).getAllByRole('button', { name: /^\d+\. / })).toHaveLength(60);
    expect(within(parent).getByRole('button', { name: '11. Visible prompt ten' })).toBeDefined();
    expect(vi.mocked(MarkdownRenderer.render)).toHaveBeenCalledTimes(rendersBefore);
    expect(renderedPrompts(messagesEl)).toHaveLength(20);

    fireEvent.click(within(parent).getByRole('button', { name: '11. Visible prompt ten' }));
    expect(renderedPrompts(messagesEl)[0]).toBe('Visible prompt ten');
    expect(renderedPrompts(messagesEl)).not.toContain('Prompt 9');
    const selected = messagesEl.querySelector<HTMLElement>('[data-message-id="u10"]')!;
    expect(messagesEl.scrollTo).toHaveBeenLastCalledWith({ top: Math.max(selected.offsetTop - 10, 0), behavior: 'smooth' });

    renderer.removeMessage('u3');
    renderer.removeMessage('u15');
    renderer.addMessage(turn(60)[0]);
    fireEvent.click(within(parent).getByRole('button', { name: 'Conversation directory' }));
    const labels = within(parent).getAllByRole('button', { name: /^\d+\. / }).map(button => button.textContent);
    expect(labels).toHaveLength(59);
    expect(labels).not.toContain('4. Prompt 3');
    expect(labels.some(label => label?.endsWith('. Prompt 15'))).toBe(false);
    expect(labels.at(-1)).toBe('59. Prompt 60');
  } finally {
    sidebar.destroy();
    renderer.dispose();
  }
});

it('offers branching from the first rendered prompt while earlier prompts are unrendered, never from the transcript start', () => {
  const { renderer, messagesEl } = setup('pi');
  const messages = Array.from({ length: 30 }, (_, index) => turn(index)).flat()
    .map(message => message.role === 'user' ? { ...message, userMessageId: `native-${message.id}`, treeBranches: [`native-${message.id}`] } : message);
  const branchFrom = (id: string) => within(messagesEl.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!)
    .queryByRole('button', { name: 'Branch from this prompt' });
  renderer.renderMessages(messages, () => 'Hello');
  expect(renderedPrompts(messagesEl)[0]).toBe('Prompt 10');
  expect(branchFrom('u10')).not.toBeNull();

  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Show earlier messages' }));
  expect(branchFrom('u0')).toBeNull();
  expect(branchFrom('u1')).not.toBeNull();
  expect(branchFrom('u10')).not.toBeNull();
});

it('returns to the reading position after cancelling a branch preview of a revealed prompt', async () => {
  const state = new ChatState();
  const inputEl = document.body.createEl('textarea');
  const history = Array.from({ length: 30 }, (_, index) => turn(index)).flat()
    .map(message => message.role === 'user' ? { ...message, userMessageId: `native-${message.id}`, treeBranches: [`native-${message.id}`] } : message);
  const plugin = { app: {}, settings: { mediaFolder: '' }, updateConversation: vi.fn(),
    getConversationById: vi.fn().mockResolvedValue({ id: 'pi-chat', messages: history }),
    getConversationSummary: vi.fn().mockReturnValue(null), projects: createProjectsFake() };
  const { renderer, messagesEl } = setup('pi', (id, target) => controller.navigateBranch(id, target));
  let welcomeEl: HTMLElement | null = null;
  const controller: ConversationController = new ConversationController({ plugin, state, renderer,
    ...createConversationPorts({ state, getInputEl: () => inputEl, getImageContextManager: () => null }),
    subagentManager: { clear: vi.fn() },
    getInputEl: () => inputEl, getMessagesEl: () => messagesEl,
    getWelcomeEl: () => welcomeEl, setWelcomeEl: (el: HTMLElement) => { welcomeEl = el; },
    getLinkedContentController: () => ({ lock: vi.fn() }),
    getImageContextManager: () => null, clearQueuedMessage: vi.fn(),
    getExecutionCoordinator: () => ({ supportsConversationBranches: true }),
  } as any);
  state.currentConversationId = 'pi-chat';
  await controller.loadActive();
  fireEvent.click(within(messagesEl).getByRole('button', { name: 'Show earlier messages' }));
  const prompt = messagesEl.querySelector<HTMLElement>('[data-message-id="u5"]')!;
  // The reader sees the lower 70px of the prompt at the top of the viewport.
  messagesEl.scrollTop = Array.from(messagesEl.children).indexOf(prompt) * 100 + 30;

  fireEvent.click(within(prompt).getByRole('button', { name: 'Branch from this prompt' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(inputEl.value).toBe('Prompt 5');
  // A reply arriving during the preview lands below the reading position.
  state.messages = [...state.messages, ...turn(30)];
  controller.cancelBranchDraft();

  expect(messagesEl.querySelector('[data-message-id="u30"]')).not.toBeNull();
  expect(messagesEl.querySelector<HTMLElement>('[data-message-id="u5"]')!.getBoundingClientRect().top).toBe(-30);
  renderer.dispose();
});

it('renders an insertion beside an unrendered earlier message in transcript order', () => {
  const { renderer, messagesEl } = setup();
  const messages = Array.from({ length: 30 }, (_, index) => turn(index)).flat();
  renderer.renderMessages(messages, () => 'Hello');
  expect(messagesEl.querySelector('[data-message-id="a3"]')).toBeNull();

  renderer.addMessage({ id: 'late', role: 'assistant', content: '', timestamp: start }, 'a3');
  const ids = Array.from(messagesEl.querySelectorAll('[data-message-id]'), el => el.getAttribute('data-message-id'));
  expect(ids.indexOf('late')).toBe(ids.indexOf('a3') + 1);
  expect(ids.at(-1)).toBe('a29');
});

it('keeps a message removed while unrendered out of the revealed transcript', () => {
  const { renderer, messagesEl } = setup();
  const messages = Array.from({ length: 30 }, (_, index) => turn(index)).flat();
  renderer.renderMessages(messages, () => 'Hello');
  renderer.removeMessage('a3');
  renderer.revealEarlierMessages(true);
  const ids = Array.from(messagesEl.querySelectorAll('[data-message-id]'), el => el.getAttribute('data-message-id'));
  expect(ids).toEqual(messages.map(message => message.id).filter(id => id !== 'a3'));
});
