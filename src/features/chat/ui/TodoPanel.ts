/**
 * TodoPanel component.
 *
 * A persistent panel at the bottom of the messages area that shows
 * the todo list (collapsible).
 *
 * Flows seamlessly with the chat - no borders or backgrounds.
 */

import { setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools';

/**
 * TodoPanel - persistent bottom panel for todos.
 */
export class TodoPanel {
  private containerEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private todoContainerEl: HTMLElement | null = null;
  private todoHeaderEl: HTMLElement | null = null;
  private todoContentEl: HTMLElement | null = null;
  private isExpanded = false;
  private currentTodos: TodoItem[] | null = null;

  // Event handler references for cleanup
  private clickHandler: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Mount the panel into the messages container.
   * Appends to the end of the messages area.
   */
  mount(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
    this.createPanel();
  }

  /**
   * Remount the panel after the container was cleared.
   * Called when messagesEl.empty() removes the panel from DOM.
   */
  remount(): void {
    if (!this.containerEl) {
      console.warn('[TodoPanel] Cannot remount - no containerEl set');
      return;
    }
    // Destroy old references and recreate
    this.panelEl = null;
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.createPanel();
  }

  /**
   * Create the panel structure.
   */
  private createPanel(): void {
    if (!this.containerEl) {
      console.warn('[TodoPanel] Cannot create panel - containerEl not set. Was mount() called correctly?');
      return;
    }

    // Create panel element (no border/background - seamless)
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'claudian-todo-panel';

    // Todo container
    this.todoContainerEl = document.createElement('div');
    this.todoContainerEl.className = 'claudian-todo-panel-todos';
    this.todoContainerEl.style.display = 'none';
    this.panelEl.appendChild(this.todoContainerEl);

    // Todo header (collapsed view)
    this.todoHeaderEl = document.createElement('div');
    this.todoHeaderEl.className = 'claudian-todo-panel-header';
    this.todoHeaderEl.setAttribute('tabindex', '0');
    this.todoHeaderEl.setAttribute('role', 'button');

    // Store handler references for cleanup
    this.clickHandler = () => this.toggle();
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggle();
      }
    };
    this.todoHeaderEl.addEventListener('click', this.clickHandler);
    this.todoHeaderEl.addEventListener('keydown', this.keydownHandler);
    this.todoContainerEl.appendChild(this.todoHeaderEl);

    // Todo content (expanded list)
    this.todoContentEl = document.createElement('div');
    this.todoContentEl.className = 'claudian-todo-panel-content';
    this.todoContentEl.style.display = 'none';
    this.todoContainerEl.appendChild(this.todoContentEl);

    this.containerEl.appendChild(this.panelEl);
  }

  /**
   * Update the panel with new todo items.
   * Called by ChatState.onTodosChanged callback when TodoWrite tool is used.
   * Passing null or empty array hides the panel.
   */
  updateTodos(todos: TodoItem[] | null): void {
    if (!this.todoContainerEl || !this.todoHeaderEl || !this.todoContentEl) {
      // Only warn if we have todos to display but component is not ready
      // Don't update internal state to keep it consistent with display
      if (todos && todos.length > 0) {
        console.warn('[TodoPanel] Cannot update todos - component not mounted or destroyed');
      }
      return;
    }

    // Update internal state only after confirming component is ready
    this.currentTodos = todos;

    if (!todos || todos.length === 0) {
      this.todoContainerEl.style.display = 'none';
      this.todoHeaderEl.empty();
      this.todoContentEl.empty();
      return;
    }

    this.todoContainerEl.style.display = 'block';

    // Count completed and find current task
    const completedCount = todos.filter(t => t.status === 'completed').length;
    const totalCount = todos.length;
    const currentTask = todos.find(t => t.status === 'in_progress');

    // Update header
    this.renderHeader(completedCount, totalCount, currentTask);

    // Update content
    this.renderContent(todos);

    // Update ARIA
    this.updateAriaLabel(completedCount, totalCount);

    this.scrollToBottom();
  }

  /**
   * Render the collapsed header.
   */
  private renderHeader(completedCount: number, totalCount: number, currentTask: TodoItem | undefined): void {
    if (!this.todoHeaderEl) return;

    this.todoHeaderEl.empty();

    // List icon
    const icon = document.createElement('span');
    icon.className = 'claudian-todo-panel-icon';
    setIcon(icon, 'list-checks');
    this.todoHeaderEl.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = 'claudian-todo-panel-label';
    label.textContent = `Tasks (${completedCount}/${totalCount})`;
    this.todoHeaderEl.appendChild(label);

    // Current task (only when collapsed)
    if (!this.isExpanded && currentTask) {
      const current = document.createElement('span');
      current.className = 'claudian-todo-panel-current';
      current.textContent = currentTask.activeForm;
      this.todoHeaderEl.appendChild(current);
    }
  }

  /**
   * Render the expanded content.
   */
  private renderContent(todos: TodoItem[]): void {
    if (!this.todoContentEl) return;

    this.todoContentEl.empty();

    for (const todo of todos) {
      const itemEl = document.createElement('div');
      itemEl.className = `claudian-todo-item claudian-todo-${todo.status}`;

      const statusIcon = document.createElement('div');
      statusIcon.className = 'claudian-todo-status-icon';
      statusIcon.setAttribute('aria-hidden', 'true');
      setIcon(statusIcon, this.getStatusIcon(todo.status));
      itemEl.appendChild(statusIcon);

      const text = document.createElement('div');
      text.className = 'claudian-todo-text';
      text.textContent = todo.status === 'in_progress' ? todo.activeForm : todo.content;
      itemEl.appendChild(text);

      this.todoContentEl.appendChild(itemEl);
    }
  }

  /**
   * Get status icon name for a todo item.
   */
  private getStatusIcon(status: TodoItem['status']): string {
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
   * Toggle expanded/collapsed state.
   */
  private toggle(): void {
    this.isExpanded = !this.isExpanded;
    this.updateDisplay();
  }

  /**
   * Update display based on expanded state.
   */
  private updateDisplay(): void {
    if (!this.todoContentEl || !this.todoHeaderEl) return;

    // Show/hide content
    this.todoContentEl.style.display = this.isExpanded ? 'block' : 'none';

    // Re-render header to update current task visibility
    if (this.currentTodos && this.currentTodos.length > 0) {
      const completedCount = this.currentTodos.filter(t => t.status === 'completed').length;
      const totalCount = this.currentTodos.length;
      const currentTask = this.currentTodos.find(t => t.status === 'in_progress');
      this.renderHeader(completedCount, totalCount, currentTask);
      this.updateAriaLabel(completedCount, totalCount);
    }

    this.scrollToBottom();
  }

  /**
   * Update ARIA label.
   */
  private updateAriaLabel(completedCount: number, totalCount: number): void {
    if (!this.todoHeaderEl) return;

    const action = this.isExpanded ? 'Collapse' : 'Expand';
    this.todoHeaderEl.setAttribute(
      'aria-label',
      `${action} task list - ${completedCount} of ${totalCount} completed`
    );
    this.todoHeaderEl.setAttribute('aria-expanded', String(this.isExpanded));
  }

  /**
   * Scroll messages container to bottom.
   */
  private scrollToBottom(): void {
    if (this.containerEl) {
      this.containerEl.scrollTop = this.containerEl.scrollHeight;
    }
  }

  /**
   * Destroy the panel.
   */
  destroy(): void {
    // Remove event listeners before removing elements
    if (this.todoHeaderEl) {
      if (this.clickHandler) {
        this.todoHeaderEl.removeEventListener('click', this.clickHandler);
      }
      if (this.keydownHandler) {
        this.todoHeaderEl.removeEventListener('keydown', this.keydownHandler);
      }
    }
    this.clickHandler = null;
    this.keydownHandler = null;

    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.containerEl = null;
    this.currentTodos = null;
  }
}
