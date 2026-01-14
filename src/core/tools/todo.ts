/**
 * Todo tool helpers.
 *
 * Parses TodoWrite tool input into typed todo items.
 */

import { TOOL_TODO_WRITE } from './toolNames';

/**
 * Todo item structure from TodoWrite tool.
 *
 * Represents a single task with imperative and progressive forms:
 * - `content`: Imperative description (e.g., "Run tests")
 * - `activeForm`: Present continuous form (e.g., "Running tests")
 */
export interface TodoItem {
  /** Imperative description of the task (e.g., "Run tests") */
  content: string;
  /** Current status of the task */
  status: 'pending' | 'in_progress' | 'completed';
  /** Present continuous form shown during execution (e.g., "Running tests") */
  activeForm: string;
}

/** Type guard for valid todo item. */
function isValidTodoItem(item: unknown): item is TodoItem {
  if (typeof item !== 'object' || item === null) return false;
  const record = item as Record<string, unknown>;
  return (
    typeof record.content === 'string' &&
    record.content.length > 0 &&
    typeof record.activeForm === 'string' &&
    record.activeForm.length > 0 &&
    typeof record.status === 'string' &&
    ['pending', 'in_progress', 'completed'].includes(record.status)
  );
}

/** Parse todos from TodoWrite tool input. */
export function parseTodoInput(input: Record<string, unknown>): TodoItem[] | null {
  if (!input.todos || !Array.isArray(input.todos)) {
    return null;
  }

  const validTodos: TodoItem[] = [];
  const invalidItems: unknown[] = [];

  for (const item of input.todos) {
    if (isValidTodoItem(item)) {
      validTodos.push(item);
    } else {
      invalidItems.push(item);
    }
  }

  // Invalid items are silently dropped

  return validTodos.length > 0 ? validTodos : null;
}

/**
 * Extract the last TodoWrite todos from a list of messages.
 * Used to restore the todo panel when loading a saved conversation.
 */
export function extractLastTodosFromMessages(
  messages: Array<{ role: string; toolCalls?: Array<{ name: string; input: Record<string, unknown> }> }>
): TodoItem[] | null {
  // Scan from the end to find the most recent TodoWrite
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.toolCalls) {
      // Find the last TodoWrite in this message
      for (let j = msg.toolCalls.length - 1; j >= 0; j--) {
        const toolCall = msg.toolCalls[j];
        if (toolCall.name === TOOL_TODO_WRITE) {
          const todos = parseTodoInput(toolCall.input);
          return todos;
        }
      }
    }
  }
  return null;
}
