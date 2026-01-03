/**
 * Claudian - Todo list parser
 *
 * Parses TodoWrite tool input into typed todo items.
 */

/** Todo item structure from TodoWrite tool. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/** Parse todos from TodoWrite tool input. */
export function parseTodoInput(input: Record<string, unknown>): TodoItem[] | null {
  if (!input.todos || !Array.isArray(input.todos)) {
    return null;
  }

  const validTodos = input.todos.filter((item): item is TodoItem => {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof item.content === 'string' &&
      typeof item.status === 'string' &&
      ['pending', 'in_progress', 'completed'].includes(item.status)
    );
  });

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
        if (toolCall.name === 'TodoWrite') {
          return parseTodoInput(toolCall.input);
        }
      }
    }
  }
  return null;
}
