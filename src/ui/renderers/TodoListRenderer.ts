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

  return input.todos.filter((item): item is TodoItem => {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof item.content === 'string' &&
      typeof item.status === 'string' &&
      ['pending', 'in_progress', 'completed'].includes(item.status)
    );
  });
}
