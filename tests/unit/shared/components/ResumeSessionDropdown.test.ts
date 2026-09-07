/** @jest-environment jsdom */

import { createMockEl } from '@test/helpers/MockElement';

import type { ConversationMeta } from '@/core/types';
import {
  ResumeSessionDropdown,
  type ResumeSessionDropdownCallbacks,
} from '@/shared/components/ResumeSessionDropdown';

function createInput(): HTMLTextAreaElement {
  const input = document.createElement('textarea');
  jest.spyOn(input, 'focus');
  jest.spyOn(input, 'addEventListener');
  jest.spyOn(input, 'removeEventListener');
  return input;
}

function createMockCallbacks(
  overrides: Partial<ResumeSessionDropdownCallbacks> = {}
): ResumeSessionDropdownCallbacks {
  return {
    onSelect: jest.fn(),
    onDismiss: jest.fn(),
    ...overrides,
  };
}

function createConversation(
  id: string,
  title: string,
  opts: Partial<ConversationMeta> = {}
): ConversationMeta {
  return {
    id,
    providerId: 'claude',
    title,
    createdAt: Date.now() - 10000,
    lastActivityAt: Date.now() - 5000,
    messageCount: 3,
    preview: 'Test preview',
    ...opts,
  };
}

function getRenderedItems(containerEl: any): { title: string; isCurrent: boolean }[] {
  const dropdownEl = containerEl.children.find(
    (c: any) => c.hasClass('claudian-resume-dropdown')
  );
  if (!dropdownEl) return [];
  const items = dropdownEl.querySelectorAll('.claudian-resume-item');
  return items.map((item: any) => {
    // Check direct children for content div, then find title inside
    let title = '';
    for (const child of item.children) {
      const found = child.querySelector?.('.claudian-resume-item-title');
      if (found) {
        title = found.textContent ?? '';
        break;
      }
    }

    return {
      title,
      isCurrent: item.hasClass('current'),
    };
  });
}

describe('ResumeSessionDropdown', () => {
  let containerEl: any;
  let inputEl: HTMLTextAreaElement;
  let callbacks: ResumeSessionDropdownCallbacks;

  const conversations: ConversationMeta[] = [
    createConversation('conv-1', 'First Chat', { lastActivityAt: 1000 }),
    createConversation('conv-2', 'Second Chat', { lastActivityAt: 3000 }),
    createConversation('conv-3', 'Third Chat', { lastActivityAt: 2000 }),
  ];

  beforeEach(() => {
    containerEl = createMockEl();
    inputEl = createInput();
    callbacks = createMockCallbacks();
  });

  describe('constructor', () => {
    it('creates dropdown with visible class', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const dropdownEl = containerEl.children.find(
        (c: any) => c.hasClass('claudian-resume-dropdown')
      );
      expect(dropdownEl).toBeDefined();
      expect(dropdownEl.hasClass('visible')).toBe(true);

      dropdown.destroy();
    });

    it('sorts conversations by lastActivityAt descending', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const items = getRenderedItems(containerEl);
      expect(items[0].title).toBe('Second Chat');  // lastActivityAt: 3000
      expect(items[1].title).toBe('Third Chat');   // lastActivityAt: 2000
      expect(items[2].title).toBe('First Chat');   // lastActivityAt: 1000

      dropdown.destroy();
    });

    it('marks current conversation', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, 'conv-2', callbacks
      );

      const items = getRenderedItems(containerEl);
      const currentItem = items.find(i => i.title === 'Second Chat');
      expect(currentItem?.isCurrent).toBe(true);

      const otherItem = items.find(i => i.title === 'First Chat');
      expect(otherItem?.isCurrent).toBe(false);

      dropdown.destroy();
    });

    it('renders empty state when no conversations', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, [], null, callbacks
      );

      const dropdownEl = containerEl.children.find(
        (c: any) => c.hasClass('claudian-resume-dropdown')
      );
      const emptyEl = dropdownEl?.querySelector('.claudian-resume-empty');
      expect(emptyEl).toBeDefined();
      expect(emptyEl?.textContent).toBe('No conversations');

      dropdown.destroy();
    });

    it('adds input event listener for auto-dismiss', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      expect(inputEl.addEventListener).toHaveBeenCalledWith('input', expect.any(Function));

      dropdown.destroy();
    });

    it('exposes the popup while preserving native textarea semantics', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const listbox = containerEl.querySelector('.claudian-resume-list');
      const items = listbox?.querySelectorAll('.claudian-resume-item') ?? [];
      const listboxId = listbox?.getAttribute('id');
      const activeOptionId = items[0]?.getAttribute('id');

      expect(listbox?.getAttribute('role')).toBe('listbox');
      expect(listbox?.getAttribute('aria-label')).toBe('Resume conversation');
      expect(listboxId).toBeTruthy();
      expect(items.map((item: any) => item.getAttribute('role'))).toEqual([
        'option',
        'option',
        'option',
      ]);
      expect(items.map((item: any) => item.getAttribute('aria-selected'))).toEqual([
        'true',
        'false',
        'false',
      ]);
      expect(inputEl).toBeInstanceOf(HTMLTextAreaElement);
      expect(inputEl.getAttribute('role')).toBeNull();
      expect(inputEl.getAttribute('aria-haspopup')).toBe('listbox');
      expect(inputEl.getAttribute('aria-expanded')).toBeNull();
      expect(inputEl.getAttribute('aria-controls')).toBe(listboxId);
      expect(inputEl.getAttribute('aria-activedescendant')).toBe(activeOptionId);

      dropdown.destroy();
    });
  });

  describe('handleKeydown', () => {
    it('returns false when dropdown is not visible', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      // Hide it first
      const dropdownEl = containerEl.children.find(
        (c: any) => c.hasClass('claudian-resume-dropdown')
      );
      dropdownEl.removeClass('visible');

      const event = { key: 'ArrowDown', preventDefault: jest.fn() } as any;
      expect(dropdown.handleKeydown(event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();

      dropdown.destroy();
    });

    it('navigates down with ArrowDown', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const event = { key: 'ArrowDown', preventDefault: jest.fn() } as any;
      const result = dropdown.handleKeydown(event);

      expect(result).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();

      dropdown.destroy();
    });

    it('keeps the active descendant and option selection in sync while navigating', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );
      const listbox = containerEl.querySelector('.claudian-resume-list');
      const items = listbox?.querySelectorAll('.claudian-resume-item') ?? [];

      dropdown.handleKeydown({ key: 'ArrowDown', preventDefault: jest.fn() } as any);

      expect(items[0]?.getAttribute('aria-selected')).toBe('false');
      expect(items[1]?.getAttribute('aria-selected')).toBe('true');
      expect(inputEl.getAttribute('aria-activedescendant')).toBe(
        items[1]?.getAttribute('id')
      );

      dropdown.destroy();
    });

    it('navigates up with ArrowUp', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      // Go down first, then up
      dropdown.handleKeydown({ key: 'ArrowDown', preventDefault: jest.fn() } as any);
      const event = { key: 'ArrowUp', preventDefault: jest.fn() } as any;
      const result = dropdown.handleKeydown(event);

      expect(result).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();

      dropdown.destroy();
    });

    it('selects with Enter', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const event = { key: 'Enter', preventDefault: jest.fn() } as any;
      const result = dropdown.handleKeydown(event);

      expect(result).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      // First item after sorting is conv-2 (highest lastActivityAt)
      expect(callbacks.onSelect).toHaveBeenCalledWith('conv-2');

      dropdown.destroy();
    });

    it('selects with Tab', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const event = { key: 'Tab', preventDefault: jest.fn() } as any;
      const result = dropdown.handleKeydown(event);

      expect(result).toBe(true);
      expect(callbacks.onSelect).toHaveBeenCalledWith('conv-2');

      dropdown.destroy();
    });

    it('dismisses with Escape', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const event = { key: 'Escape', preventDefault: jest.fn() } as any;
      const result = dropdown.handleKeydown(event);

      expect(result).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(callbacks.onDismiss).toHaveBeenCalled();

      dropdown.destroy();
    });

    it('returns false for unhandled keys', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const event = { key: 'a', preventDefault: jest.fn() } as any;
      const result = dropdown.handleKeydown(event);

      expect(result).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();

      dropdown.destroy();
    });

    it('dismisses when selecting current conversation', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, 'conv-2', callbacks
      );

      // conv-2 is first after sorting (highest lastActivityAt), so Enter selects it
      const event = { key: 'Enter', preventDefault: jest.fn() } as any;
      dropdown.handleKeydown(event);

      // Should dismiss, not call onSelect
      expect(callbacks.onSelect).not.toHaveBeenCalled();
      expect(callbacks.onDismiss).toHaveBeenCalled();

      dropdown.destroy();
    });
  });

  describe('isVisible', () => {
    it('returns true after construction', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      expect(dropdown.isVisible()).toBe(true);

      dropdown.destroy();
    });

    it('returns false after Escape', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      dropdown.handleKeydown({ key: 'Escape', preventDefault: jest.fn() } as any);

      expect(dropdown.isVisible()).toBe(false);

      dropdown.destroy();
    });
  });

  describe('destroy', () => {
    it('removes input event listener', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      dropdown.destroy();

      expect(inputEl.removeEventListener).toHaveBeenCalledWith('input', expect.any(Function));
    });

    it('restores the input accessibility attributes it temporarily owns', () => {
      inputEl.setAttribute('role', 'textbox');
      inputEl.setAttribute('aria-controls', 'existing-popup');
      inputEl.setAttribute('aria-expanded', 'false');
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      expect(inputEl.getAttribute('role')).toBe('textbox');
      expect(inputEl.getAttribute('aria-expanded')).toBeNull();

      dropdown.destroy();

      expect(inputEl.getAttribute('role')).toBe('textbox');
      expect(inputEl.getAttribute('aria-controls')).toBe('existing-popup');
      expect(inputEl.getAttribute('aria-haspopup')).toBeNull();
      expect(inputEl.getAttribute('aria-expanded')).toBe('false');
      expect(inputEl.getAttribute('aria-activedescendant')).toBeNull();
    });
  });

  describe('click selection', () => {
    it('calls onSelect when clicking a non-current item', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, 'conv-1', callbacks
      );

      const dropdownEl = containerEl.children.find(
        (c: any) => c.hasClass('claudian-resume-dropdown')
      );
      const items = dropdownEl.querySelectorAll('.claudian-resume-item');
      // Find a non-current item (conv-2 is first, conv-1 is current)
      const nonCurrentItem = items.find((i: any) => !i.hasClass('current'));
      nonCurrentItem?.dispatchEvent('click');

      expect(callbacks.onSelect).toHaveBeenCalled();

      dropdown.destroy();
    });

    it('dismisses when clicking current item', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, 'conv-2', callbacks
      );

      const dropdownEl = containerEl.children.find(
        (c: any) => c.hasClass('claudian-resume-dropdown')
      );
      const items = dropdownEl.querySelectorAll('.claudian-resume-item');
      // conv-2 is first after sorting and is current
      const currentItem = items.find((i: any) => i.hasClass('current'));
      currentItem?.dispatchEvent('click');

      expect(callbacks.onSelect).not.toHaveBeenCalled();
      expect(callbacks.onDismiss).toHaveBeenCalled();

      dropdown.destroy();
    });
  });
});
