/** @jest-environment jsdom */

import { ConversationController, type ConversationControllerDeps } from '@/features/chat/controllers/ConversationController';
import { ChatState } from '@/features/chat/state/ChatState';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };

function createController(): ConversationController {
  const state = new ChatState();
  const inputEl = document.createElement('textarea');
  const messagesEl = document.createElement('div');

  return new ConversationController({
    plugin: {
      getConversationList: jest.fn().mockReturnValue([{
        id: 'session-1',
        providerId: 'codex',
        title: 'Review architecture',
        createdAt: 1_000,
        lastActivityAt: 2_000,
        linkedContentPath: 'Projects/A linked content title that overflows the popover.md',
      }]),
      settings: {},
    },
    state,
    renderer: {},
    subagentManager: {},
    getHistoryDropdown: () => null,
    getWelcomeEl: () => null,
    setWelcomeEl: jest.fn(),
    getMessagesEl: () => messagesEl,
    getInputEl: () => inputEl,
    getLinkedContentController: () => ({}),
    getImageContextManager: () => ({}),
    clearQueuedMessage: jest.fn(),
    getTitleGenerationService: () => null,
    getExecutionCoordinator: () => null,
  } as unknown as ConversationControllerDeps);
}

describe('ConversationController session metadata popover', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('stays open for its own content scroll and closes for an external scroll', () => {
    const controller = createController();
    const container = document.createElement('div');
    document.body.appendChild(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined),
      showMetadataPopover: true,
    });

    const item = container.querySelector<HTMLElement>('.claudian-history-item')!;
    item.dispatchEvent(new MouseEvent('mouseenter'));

    const popover = document.body.querySelector<HTMLElement>(
      '.claudian-session-metadata-popover',
    )!;
    const linkedContent = popover.querySelector<HTMLElement>(
      '.claudian-session-metadata-value--content',
    )!;

    linkedContent.dispatchEvent(new Event('scroll'));
    expect(popover.isConnected).toBe(true);

    container.dispatchEvent(new Event('scroll'));
    expect(popover.isConnected).toBe(false);
  });
});
