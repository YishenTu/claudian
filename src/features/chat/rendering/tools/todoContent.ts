import { setIcon } from 'obsidian';

import type { TodoItem } from '@/core/tools/todo';
import { setToolStatus } from '@/features/chat/rendering/tools/toolStatus';

function getTodos(input: Record<string, unknown>): TodoItem[] | undefined {
  const todos = input.todos;
  if (!todos || !Array.isArray(todos)) return undefined;
  return todos as TodoItem[];
}

function countCompleted(todos: TodoItem[]): number {
  return todos.filter(t => t.status === 'completed').length;
}

export function getTodoName(input: Record<string, unknown>): string {
  const todos = getTodos(input);
  return todos && todos.length > 0 ? `Tasks ${countCompleted(todos)}/${todos.length}` : 'Tasks';
}

export function getTodoLabel(input: Record<string, unknown>): string {
  const todos = getTodos(input);
  return todos ? `Tasks (${countCompleted(todos)}/${todos.length})` : 'Tasks';
}

/** The in-progress task's active form, shown beside the collapsed header. */
export function getCurrentTaskText(input: Record<string, unknown>): string {
  return getTodos(input)?.find(t => t.status === 'in_progress')?.activeForm ?? '';
}

export function setTodoWriteStatus(statusEl: HTMLElement, input: Record<string, unknown>): void {
  const isComplete = getTodos(input)?.every(t => t.status === 'completed') ?? false;
  if (isComplete) {
    setToolStatus(statusEl, 'completed', 'claudian-tool-status');
  } else {
    setToolStatus(statusEl, 'running', 'claudian-tool-status', 'Status: in progress');
  }
}

export function renderTodoWriteContent(container: HTMLElement, input: Record<string, unknown>): void {
  container.empty();
  container.addClass('claudian-tool-content-todo');
  container.addClass('claudian-todo-list-container');

  const todos = getTodos(input);
  if (!todos) {
    const item = container.createSpan({ cls: 'claudian-tool-result-item' });
    item.setText('Tasks updated');
    return;
  }

  for (const todo of todos) {
    const item = container.createDiv({ cls: `claudian-todo-item claudian-todo-${todo.status}` });

    const icon = item.createSpan({ cls: 'claudian-todo-status-icon' });
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, todo.status === 'completed' ? 'check' : 'dot');

    const text = item.createSpan({ cls: 'claudian-todo-text' });
    text.setText(todo.status === 'in_progress' ? todo.activeForm : todo.content);
  }
}
