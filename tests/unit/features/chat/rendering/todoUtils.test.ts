import { createMockEl } from '@test/helpers/mockElement';
import { setIcon } from 'obsidian';

import type { TodoItem } from '@/core/tools';
import {
  getTodoDisplayText,
  getTodoStatusIcon,
  renderTodoItems,
} from '@/features/chat/rendering/todoUtils';

jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
}));

describe('todoUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTodoStatusIcon', () => {
    it('should return "check" for completed', () => {
      expect(getTodoStatusIcon('completed')).toBe('check');
    });

    it('should return "dot" for pending', () => {
      expect(getTodoStatusIcon('pending')).toBe('dot');
    });

    it('should return "dot" for in_progress', () => {
      expect(getTodoStatusIcon('in_progress')).toBe('dot');
    });
  });

  describe('getTodoDisplayText', () => {
    it('should return activeForm for in_progress', () => {
      const todo: TodoItem = { status: 'in_progress', content: 'Fix bug', activeForm: 'Fixing bug' };
      expect(getTodoDisplayText(todo)).toBe('Fixing bug');
    });

    it('should return content for completed', () => {
      const todo: TodoItem = { status: 'completed', content: 'Fix bug', activeForm: 'Fixing bug' };
      expect(getTodoDisplayText(todo)).toBe('Fix bug');
    });

    it('should return content for pending', () => {
      const todo: TodoItem = { status: 'pending', content: 'Fix bug', activeForm: 'Fixing bug' };
      expect(getTodoDisplayText(todo)).toBe('Fix bug');
    });
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

      // First item: completed
      expect(container._children[0].hasClass('claudian-todo-completed')).toBe(true);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'check');

      // Second item: in_progress shows activeForm
      expect(container._children[1].hasClass('claudian-todo-in_progress')).toBe(true);

      // Third item: pending
      expect(container._children[2].hasClass('claudian-todo-pending')).toBe(true);
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
