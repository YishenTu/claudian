/** @jest-environment jsdom */

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { setIcon } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import { SessionBrowser, type SessionBrowserDeps } from '@/features/chat/session-manager/SessionBrowser';
import { ChatState } from '@/features/chat/state/ChatState';
import { OPENAI_PROVIDER_ICON } from '@/shared/icons';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.hasClass = function (className) { return this.classList.contains(className); };

function createController(conversations?: ConversationMeta[]): SessionBrowser {
  const state = new ChatState();
  const inputEl = document.createElement('textarea');
  const messagesEl = document.createElement('div');

  return new SessionBrowser({
    plugin: {
      getConversationList: jest.fn().mockReturnValue(conversations ?? [{
        id: 'session-1',
        providerId: 'codex',
        title: 'Review architecture',
        createdAt: testDate({ minutes: -1 }).getTime(),
        lastActivityAt: testDate().getTime(),
        linkedContentPath: 'Projects/A linked content title that overflows the popover.md',
      }]),
      settings: {},
    },
    getCurrentConversationId: () => state.currentConversationId,
    isStreaming: () => false,
    reloadActiveConversation: async () => undefined,
    onListChanged: () => undefined,
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
  } as unknown as SessionBrowserDeps);
}

describe('SessionBrowser session metadata popover', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
  });

  it.each([
    ['Projects/Architecture.md', 'Architecture'],
    [undefined, null],
    ['Projects/Untitled', 'Untitled'],
  ])('shows current metadata and accessible controls for linked content %s', (linkedContentPath, title) => {
    const controller = createController([{
      id: 'session-1', providerId: 'codex', selectedModel: 'gpt-5.1-codex', title: 'Review architecture',
      createdAt: testDate({ days: -1 }).getTime(), lastActivityAt: testDate().getTime(),
      linkedContentPath, messageCount: 1, preview: '',
    }]);
    jest.spyOn(controller, 'formatMetadataDate').mockReturnValue('Created date');
    jest.spyOn(controller, 'formatMetadataDateTime').mockReturnValue('Last active date and time');
    const container = document.createElement('div');
    document.body.append(container);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined), showMetadataPopover: true,
      organization: 'linked-content', language: 'en', contentExists: () => true, contentIsNote: () => false,
      getProviderIcon: () => OPENAI_PROVIDER_ICON, getModelLabel: () => 'GPT-5.1 Codex',
    });
    const content = within(container).getByRole('button', { name: /Review architecture/ });
    const item = content.closest<HTMLElement>('.claudian-history-item')!;
    jest.spyOn(item, 'getBoundingClientRect').mockReturnValue({
      top: 120, left: 20, right: 220, bottom: 148, width: 200, height: 28, x: 20, y: 120, toJSON: () => ({}),
    });
    expect(item.getAttribute('tabindex')).toBeNull();
    expect(item.getAttribute('role')).toBeNull();
    expect(content.getAttribute('tabindex')).toBe('0');
    expect(item.querySelector('.claudian-history-item-date')).toBeNull();
    fireEvent.mouseEnter(item);
    const tooltip = within(document.body).getByRole('tooltip');
    expect([...tooltip.querySelectorAll('.claudian-session-metadata-label')].map(label => label.textContent))
      .toEqual(['Created', 'Last active']);
    const visibleRows = [...tooltip.children].filter(row => !row.classList.contains('claudian-hidden'));
    expect(visibleRows.map(row => row.querySelector('.claudian-session-metadata-value')?.textContent))
      .toEqual([...(title ? [title] : []), 'GPT-5.1 Codex', 'Created date', 'Last active date and time']);
    expect(tooltip.querySelector('.claudian-session-metadata-provider-icon')).not.toBeNull();
    expect(tooltip.style.top).toBe('120px');
    expect(tooltip.querySelector('.claudian-session-metadata-value--content')?.getAttribute('title'))
      .toBe(linkedContentPath ?? '');
    fireEvent.keyDown(content, { key: 'Escape' });
    expect(tooltip.isConnected).toBe(false);
    fireEvent.focusIn(content);
    expect(within(document.body).getAllByRole('tooltip')).toEqual([tooltip]);
    controller.dispose();
  });

  it('reuses popover rows and icons across keyboard activation while updating content and ARIA', async () => {
    const first: ConversationMeta = { id: 'one', providerId: 'claude', title: 'First session', messageCount: 1, preview: '',
      createdAt: testDate({ days: -2 }).getTime(), lastActivityAt: testDate().getTime(), linkedContentPath: 'First.md' };
    const second: ConversationMeta = { ...first, id: 'two', title: 'Second session', linkedContentPath: undefined };
    const controller = createController([first, second]);
    const container = document.createElement('div');
    document.body.append(container);
    const icon = { viewBox: '0 0 16 16', path: 'M0 0h8v8z' };
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined), showMetadataPopover: true,
      getProviderIcon: () => ({ ...icon }),
      getModelLabel: conversation => conversation.id === 'one' ? 'Model one' : 'Model two',
    });
    const firstButton = within(container).getByRole('button', { name: /First session/ });
    const secondButton = within(container).getByRole('button', { name: /Second session/ });
    fireEvent.focusIn(firstButton);
    const tooltip = within(document.body).getByRole('tooltip');
    const rows = [...tooltip.children];
    const svg = tooltip.querySelector('svg');
    expect(svg?.getAttribute('data-provider')).toBe('claude');
    expect(tooltip.textContent).toContain('Model one');
    expect(tooltip.textContent).toContain('First');
    expect(firstButton.getAttribute('aria-describedby')).toBe(tooltip.id);
    jest.mocked(setIcon).mockClear();
    fireEvent.focusIn(secondButton);
    expect(within(document.body).getByRole('tooltip')).toBe(tooltip);
    expect(tooltip.children).toHaveLength(rows.length);
    rows.forEach((row, index) => expect(tooltip.children[index]).toBe(row));
    expect(tooltip.querySelector('svg')).toBe(svg);
    expect(tooltip.querySelector('.claudian-session-metadata-value--content')?.parentElement?.classList.contains('claudian-hidden')).toBe(true);
    expect(tooltip.textContent).toContain('Model two');
    expect(firstButton.hasAttribute('aria-describedby')).toBe(false);
    expect(secondButton.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(jest.mocked(setIcon)).not.toHaveBeenCalled();
    expect((await axe(tooltip)).violations).toEqual([]);
    fireEvent.keyDown(secondButton, { key: 'Escape' });
    expect(within(document.body).queryByRole('tooltip')).toBeNull();
    expect(secondButton.hasAttribute('aria-describedby')).toBe(false);
    first.linkedContentPath = 'Updated.md';
    icon.path = 'M0 0h4v4z';
    fireEvent.focusIn(firstButton);
    expect(within(document.body).getByRole('tooltip')).toBe(tooltip);
    expect(tooltip.textContent).toContain('Updated');
    expect(tooltip.querySelector('svg')).not.toBe(svg);
    expect(tooltip.querySelector('svg path')?.getAttribute('d')).toBe(icon.path);
    expect(tooltip.querySelector('.claudian-session-metadata-value--content')?.parentElement?.classList.contains('claudian-hidden')).toBe(false);
    controller.dispose();
    expect(tooltip.isConnected).toBe(false);
  });

  it('detaches reused content and removes its ARIA association on abort and resize', () => {
    const controller = createController();
    const container = document.createElement('div');
    document.body.append(container);
    const abort = new AbortController();
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined), showMetadataPopover: true, signal: abort.signal,
    });
    const button = within(container).getByRole('button', { name: /Review architecture/ });
    fireEvent.focusIn(button);
    const tooltip = within(document.body).getByRole('tooltip');
    abort.abort();
    expect(tooltip.isConnected).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    controller.renderHistoryDropdown(container, {
      onSelectConversation: jest.fn().mockResolvedValue(undefined), showMetadataPopover: true,
    });
    const nextButton = within(container).getByRole('button', { name: /Review architecture/ });
    fireEvent.focusIn(nextButton);
    expect(within(document.body).getByRole('tooltip')).toBe(tooltip);
    fireEvent(window, new Event('resize'));
    expect(tooltip.isConnected).toBe(false);
    expect(nextButton.hasAttribute('aria-describedby')).toBe(false);
    controller.dispose();
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
