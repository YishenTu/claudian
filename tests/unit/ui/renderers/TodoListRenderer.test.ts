/**
 * Tests for TodoListRenderer - TodoWrite input parsing
 */

import { parseTodoInput } from '@/ui/renderers/TodoListRenderer';

describe('TodoListRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseTodoInput', () => {
    it('should parse valid todo input', () => {
      const input = {
        todos: [
          { content: 'Task 1', status: 'pending', activeForm: 'Doing Task 1' },
          { content: 'Task 2', status: 'completed', activeForm: 'Doing Task 2' },
        ],
      };

      const result = parseTodoInput(input);

      expect(result).toHaveLength(2);
      expect(result![0].content).toBe('Task 1');
      expect(result![1].status).toBe('completed');
    });

    it('should return null for invalid input', () => {
      expect(parseTodoInput({})).toBeNull();
      expect(parseTodoInput({ todos: 'not an array' })).toBeNull();
    });

    it('should filter out invalid todo items', () => {
      const input = {
        todos: [
          { content: 'Valid', status: 'pending', activeForm: 'Doing' },
          { content: 'Invalid status', status: 'unknown' },
          { status: 'pending' },
        ],
      };

      const result = parseTodoInput(input);

      expect(result).toHaveLength(1);
      expect(result![0].content).toBe('Valid');
    });
  });
});
