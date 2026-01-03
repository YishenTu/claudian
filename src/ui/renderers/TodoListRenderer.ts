/**
 * Claudian - Todo list parser
 *
 * Parses TodoWrite tool input into typed todo items.
 */

import { TOOL_TODO_WRITE } from '@/core/tools';

/** Todo item structure from TodoWrite tool. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/** Type guard for valid todo item. */
function isValidTodoItem(item: unknown): item is TodoItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as Record<string, unknown>).content === 'string' &&
    typeof (item as Record<string, unknown>).activeForm === 'string' &&
    typeof (item as Record<string, unknown>).status === 'string' &&
    ['pending', 'in_progress', 'completed'].includes((item as Record<string, unknown>).status as string)
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

  if (invalidItems.length > 0) {
    console.warn('[TodoListRenderer] Dropped invalid todo items:', {
      dropped: invalidItems.length,
      total: input.todos.length,
      sample: invalidItems.slice(0, 3),
    });
  }

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
          return parseTodoInput(toolCall.input);
        }
      }
    }
  }
  return null;
}
