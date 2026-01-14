/**
 * Tests for TodoListRenderer - TodoWrite input parsing
 */

import { extractLastTodosFromMessages, parseTodoInput } from '@/features/chat/rendering/TodoListRenderer';

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

    it('should filter out items with empty strings', () => {
      const input = {
        todos: [
          { content: '', status: 'pending', activeForm: 'Doing' },
          { content: 'Valid', status: 'pending', activeForm: '' },
          { content: 'Also valid', status: 'completed', activeForm: 'Done' },
        ],
      };

      const result = parseTodoInput(input);

      expect(result).toHaveLength(1);
      expect(result![0].content).toBe('Also valid');
    });
  });

  describe('extractLastTodosFromMessages', () => {
    it('should return the most recent TodoWrite from conversation', () => {
      const messages = [
        {
          role: 'assistant',
          toolCalls: [{
            name: 'TodoWrite',
            input: { todos: [{ content: 'Old task', status: 'completed', activeForm: 'Old' }] },
          }],
        },
        { role: 'user' },
        {
          role: 'assistant',
          toolCalls: [{
            name: 'TodoWrite',
            input: { todos: [{ content: 'New task', status: 'pending', activeForm: 'New' }] },
          }],
        },
      ];

      const result = extractLastTodosFromMessages(messages);

      expect(result).not.toBeNull();
      expect(result![0].content).toBe('New task');
      expect(result![0].status).toBe('pending');
    });

    it('should return null when no TodoWrite exists', () => {
      const messages = [
        { role: 'assistant', toolCalls: [{ name: 'Read', input: {} }] },
        { role: 'user' },
      ];

      expect(extractLastTodosFromMessages(messages)).toBeNull();
    });

    it('should return null for empty messages array', () => {
      expect(extractLastTodosFromMessages([])).toBeNull();
    });

    it('should handle messages without toolCalls', () => {
      const messages = [
        { role: 'assistant' },
        { role: 'user' },
      ];

      expect(extractLastTodosFromMessages(messages)).toBeNull();
    });

    it('should ignore user messages with toolCalls', () => {
      const messages = [
        {
          role: 'user',
          toolCalls: [{
            name: 'TodoWrite',
            input: { todos: [{ content: 'User task', status: 'pending', activeForm: 'Task' }] },
          }],
        },
      ];

      expect(extractLastTodosFromMessages(messages)).toBeNull();
    });

    it('should find TodoWrite among other tool calls', () => {
      const messages = [
        {
          role: 'assistant',
          toolCalls: [
            { name: 'Read', input: {} },
            { name: 'TodoWrite', input: { todos: [{ content: 'Task', status: 'in_progress', activeForm: 'Doing' }] } },
            { name: 'Write', input: {} },
          ],
        },
      ];

      const result = extractLastTodosFromMessages(messages);

      expect(result).not.toBeNull();
      expect(result![0].content).toBe('Task');
    });

    it('should return the last TodoWrite in a message with multiple TodoWrites', () => {
      const messages = [
        {
          role: 'assistant',
          toolCalls: [
            { name: 'TodoWrite', input: { todos: [{ content: 'First', status: 'pending', activeForm: 'First' }] } },
            { name: 'TodoWrite', input: { todos: [{ content: 'Last', status: 'pending', activeForm: 'Last' }] } },
          ],
        },
      ];

      const result = extractLastTodosFromMessages(messages);

      expect(result).not.toBeNull();
      expect(result![0].content).toBe('Last');
    });

    it('should return null when TodoWrite parsing fails', () => {
      const messages = [
        {
          role: 'assistant',
          toolCalls: [
            { name: 'TodoWrite', input: { todos: 'invalid' } }, // Invalid: todos should be array
          ],
        },
      ];

      const result = extractLastTodosFromMessages(messages);

      expect(result).toBeNull();
    });
  });
});
