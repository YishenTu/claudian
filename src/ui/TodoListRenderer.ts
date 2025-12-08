import { setIcon } from 'obsidian';

/**
 * Todo item structure from TodoWrite tool
 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

/**
 * Parse todos from TodoWrite tool input
 */
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

/**
 * Get status icon name for a todo item
 */
function getStatusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return 'check-circle-2';
    case 'in_progress':
      return 'circle-dot';
    case 'pending':
    default:
      return 'circle';
  }
}

/**
 * Render a TodoWrite tool call as a todo list
 */
export function renderTodoList(
  parentEl: HTMLElement,
  todos: TodoItem[],
  isExpanded: boolean = true
): HTMLElement {
  const container = parentEl.createDiv({ cls: 'claudian-todo-list' });
  if (isExpanded) {
    container.addClass('expanded');
  }

  // Header (clickable to collapse/expand)
  const header = container.createDiv({ cls: 'claudian-todo-header' });

  const chevron = header.createDiv({ cls: 'claudian-todo-chevron' });
  setIcon(chevron, isExpanded ? 'chevron-down' : 'chevron-right');

  const icon = header.createDiv({ cls: 'claudian-todo-icon' });
  setIcon(icon, 'list-checks');

  // Count completed vs total
  const completedCount = todos.filter(t => t.status === 'completed').length;
  const totalCount = todos.length;
  const currentTask = todos.find(t => t.status === 'in_progress');

  const label = header.createDiv({ cls: 'claudian-todo-label' });
  if (currentTask) {
    label.setText(`${currentTask.activeForm} (${completedCount}/${totalCount})`);
  } else {
    label.setText(`Tasks (${completedCount}/${totalCount})`);
  }

  // Content (collapsible)
  const content = container.createDiv({ cls: 'claudian-todo-content' });
  if (!isExpanded) {
    content.style.display = 'none';
  }

  // Render each todo item
  for (const todo of todos) {
    const itemEl = content.createDiv({
      cls: `claudian-todo-item claudian-todo-${todo.status}`
    });

    const statusIcon = itemEl.createDiv({ cls: 'claudian-todo-status-icon' });
    setIcon(statusIcon, getStatusIcon(todo.status));

    const text = itemEl.createDiv({ cls: 'claudian-todo-text' });
    // Show activeForm for in_progress, content otherwise
    text.setText(todo.status === 'in_progress' ? todo.activeForm : todo.content);
  }

  // Toggle collapse on header click
  header.addEventListener('click', () => {
    const expanded = container.hasClass('expanded');
    if (expanded) {
      container.removeClass('expanded');
      setIcon(chevron, 'chevron-right');
      content.style.display = 'none';
    } else {
      container.addClass('expanded');
      setIcon(chevron, 'chevron-down');
      content.style.display = 'block';
    }
  });

  return container;
}

/**
 * Render a stored TodoWrite tool call (from conversation history)
 */
export function renderStoredTodoList(
  parentEl: HTMLElement,
  input: Record<string, unknown>
): HTMLElement | null {
  const todos = parseTodoInput(input);
  if (!todos) {
    return null;
  }
  // Stored todos are collapsed by default
  return renderTodoList(parentEl, todos, false);
}
