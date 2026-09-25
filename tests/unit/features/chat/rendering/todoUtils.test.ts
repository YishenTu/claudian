import { createMockEl } from '@test/helpers/MockElement';
import { setIcon } from 'obsidian';

import type { TodoItem } from '@/core/tools/todo';
import { renderTodoItems } from '@/features/chat/rendering/todoUtils';

jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
}));

describe('todoUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('renderTodoItems', () => {
    it('should render todo items with status icons and text', () => {
      const container = createMockEl();
      const todos: TodoItem[] = [
        { status: 'completed', content: 'Task 1', activeForm: 'Doing Task 1' },
        { status: 'in_progress', content: 'Task 2', activeForm: 'Doing Task 2' },
        { status: 'pending', content: 'Task 3', activeForm: 'Doing Task 3' },
      ];

      renderTodoItems(container as unknown as HTMLElement, todos);

      expect(container._children.length).toBe(3);
      expect(setIcon).toHaveBeenCalledTimes(3);

      const expected = [
        { status: 'completed', icon: 'check', text: 'Task 1' },
        { status: 'in_progress', icon: 'dot', text: 'Doing Task 2' },
        { status: 'pending', icon: 'dot', text: 'Task 3' },
      ];
      expected.forEach(({ status, icon, text }, index) => {
        const item = container._children[index];
        expect(item.hasClass(`claudian-todo-${status}`)).toBe(true);
        expect(setIcon).toHaveBeenNthCalledWith(index + 1, item._children[0], icon);
        expect(item._children[1].textContent).toBe(text);
      });
    });

    it('should clear container before rendering', () => {
      const container = createMockEl();
      container.createDiv({ text: 'old content' });

      renderTodoItems(container as unknown as HTMLElement, [
        { status: 'completed', content: 'New', activeForm: 'New' },
      ]);

      // Should have exactly 1 child (old cleared, new added)
      expect(container._children.length).toBe(1);
    });

    it('should handle empty todos array', () => {
      const container = createMockEl();
      renderTodoItems(container as unknown as HTMLElement, []);
      expect(container._children.length).toBe(0);
    });

    it('should set aria-hidden on status icon', () => {
      const container = createMockEl();
      renderTodoItems(container as unknown as HTMLElement, [
        { status: 'completed', content: 'Task', activeForm: 'Task' },
      ]);

      const item = container._children[0];
      const icon = item._children[0];
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    });
  });
});
