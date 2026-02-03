import { createMockEl } from '@test/helpers/mockElement';

import type { ConversationMeta } from '@/core/types';
import {
  ResumeSessionDropdown,
  type ResumeSessionDropdownCallbacks,
} from '@/shared/components/ResumeSessionDropdown';

function createMockInput(): any {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    focus: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
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
    title,
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 5000,
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
  let inputEl: any;
  let callbacks: ResumeSessionDropdownCallbacks;

  const conversations: ConversationMeta[] = [
    createConversation('conv-1', 'First Chat', { lastResponseAt: 1000 }),
    createConversation('conv-2', 'Second Chat', { lastResponseAt: 3000 }),
    createConversation('conv-3', 'Third Chat', { lastResponseAt: 2000 }),
  ];

  beforeEach(() => {
    containerEl = createMockEl();
    inputEl = createMockInput();
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

    it('sorts conversations by lastResponseAt descending', () => {
      const dropdown = new ResumeSessionDropdown(
        containerEl, inputEl, conversations, null, callbacks
      );

      const items = getRenderedItems(containerEl);
      expect(items[0].title).toBe('Second Chat');  // lastResponseAt: 3000
      expect(items[1].title).toBe('Third Chat');   // lastResponseAt: 2000
      expect(items[2].title).toBe('First Chat');   // lastResponseAt: 1000

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
      // First item after sorting is conv-2 (highest lastResponseAt)
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

      // conv-2 is first after sorting (highest lastResponseAt), so Enter selects it
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
