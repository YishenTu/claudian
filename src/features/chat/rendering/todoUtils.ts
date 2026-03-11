import { setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools';

export function getTodoStatusIcon(status: TodoItem['status']): string {
  return status === 'completed' ? 'check' : 'dot';
}

export function getTodoDisplayText(todo: TodoItem): string {
  return todo.status === 'in_progress' ? todo.activeForm : todo.content;
}

export function renderTodoItems(
  container: HTMLElement,
  todos: TodoItem[]
): void {
  container.empty();

  for (const todo of todos) {
    const item = container.createDiv({ cls: `geminian-todo-item geminian-todo-${todo.status}` });

    const icon = item.createSpan({ cls: 'geminian-todo-status-icon' });
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, getTodoStatusIcon(todo.status));

    const text = item.createSpan({ cls: 'geminian-todo-text' });
    text.setText(getTodoDisplayText(todo));
  }
}
