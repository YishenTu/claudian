/**
 * StatusPanel component.
 *
 * A persistent panel at the bottom of the messages area that shows
 * async subagent status and todos.
 *
 * Subagent display:
 * - Running: "X background tasks" (count only)
 * - Done: "✓ description" for each completed task
 * - Done entries cleared on next user query
 *
 * Flows seamlessly with the chat - no borders or backgrounds.
 */

import { setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools';
import { getToolIcon } from '../../../core/tools/toolIcons';
import { TOOL_TASK, TOOL_TODO_WRITE } from '../../../core/tools/toolNames';
import type { AsyncSubagentStatus } from '../../../core/types';
import { renderTodoItems } from '../rendering/todoUtils';

/** Terminal states for async subagents (no longer trackable). */
const TERMINAL_STATES: PanelSubagentInfo['status'][] = ['completed', 'error', 'orphaned'];

/** Async subagent display info for the panel. */
export interface PanelSubagentInfo {
  id: string;
  description: string;
  status: AsyncSubagentStatus;
  prompt?: string;
  result?: string;
}

/**
 * StatusPanel - persistent bottom panel for async subagent status and todos.
 */
export class StatusPanel {
  private containerEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;

  // Async subagent section (above todos)
  private subagentContainerEl: HTMLElement | null = null;
  private currentSubagents: Map<string, PanelSubagentInfo> = new Map();

  // Todo section
  private todoContainerEl: HTMLElement | null = null;
  private todoHeaderEl: HTMLElement | null = null;
  private todoContentEl: HTMLElement | null = null;
  private isTodoExpanded = false;
  private currentTodos: TodoItem[] | null = null;

  // Event handler references for cleanup
  private todoClickHandler: (() => void) | null = null;
  private todoKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Mount the panel into the messages container.
   * Appends to the end of the messages area.
   */
  mount(containerEl: HTMLElement): void {
    this.containerEl = containerEl;
    this.createPanel();
  }

  /**
   * Remount the panel to restore state after conversation changes.
   * Re-creates the panel structure and re-renders current state.
   */
  remount(): void {
    if (!this.containerEl) {
      return;
    }

    // Remove old event listeners before removing DOM
    if (this.todoHeaderEl) {
      if (this.todoClickHandler) {
        this.todoHeaderEl.removeEventListener('click', this.todoClickHandler);
      }
      if (this.todoKeydownHandler) {
        this.todoHeaderEl.removeEventListener('keydown', this.todoKeydownHandler);
      }
    }
    this.todoClickHandler = null;
    this.todoKeydownHandler = null;

    // Remove old panel from DOM
    if (this.panelEl) {
      this.panelEl.remove();
    }

    // Clear references and recreate
    this.panelEl = null;
    this.subagentContainerEl = null;
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.createPanel();

    // Re-render current state
    this.renderSubagentStatus();
    if (this.currentTodos && this.currentTodos.length > 0) {
      this.updateTodos(this.currentTodos);
    }
  }

  /**
   * Create the panel structure.
   */
  private createPanel(): void {
    if (!this.containerEl) {
      return;
    }

    // Create panel element (no border/background - seamless)
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'claudian-status-panel';

    // Async subagent container (above todos) - hidden by default
    this.subagentContainerEl = document.createElement('div');
    this.subagentContainerEl.className = 'claudian-status-panel-subagents';
    this.subagentContainerEl.style.display = 'none';
    this.panelEl.appendChild(this.subagentContainerEl);

    // Todo container
    this.todoContainerEl = document.createElement('div');
    this.todoContainerEl.className = 'claudian-status-panel-todos';
    this.todoContainerEl.style.display = 'none';
    this.panelEl.appendChild(this.todoContainerEl);

    // Todo header (collapsed view)
    this.todoHeaderEl = document.createElement('div');
    this.todoHeaderEl.className = 'claudian-status-panel-header';
    this.todoHeaderEl.setAttribute('tabindex', '0');
    this.todoHeaderEl.setAttribute('role', 'button');

    // Store handler references for cleanup
    this.todoClickHandler = () => this.toggleTodos();
    this.todoKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleTodos();
      }
    };
    this.todoHeaderEl.addEventListener('click', this.todoClickHandler);
    this.todoHeaderEl.addEventListener('keydown', this.todoKeydownHandler);
    this.todoContainerEl.appendChild(this.todoHeaderEl);

    // Todo content (expanded list)
    this.todoContentEl = document.createElement('div');
    this.todoContentEl.className = 'claudian-status-panel-content claudian-todo-list-container';
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
      // Component not ready - don't update internal state to keep it consistent with display
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
    this.renderTodoHeader(completedCount, totalCount, currentTask);

    // Update content
    this.renderTodoContent(todos);

    // Update ARIA
    this.updateTodoAriaLabel(completedCount, totalCount);

    this.scrollToBottom();
  }

  /**
   * Render the todo collapsed header.
   */
  private renderTodoHeader(completedCount: number, totalCount: number, currentTask: TodoItem | undefined): void {
    if (!this.todoHeaderEl) return;

    this.todoHeaderEl.empty();

    // List icon
    const icon = document.createElement('span');
    icon.className = 'claudian-status-panel-icon';
    setIcon(icon, getToolIcon(TOOL_TODO_WRITE));
    this.todoHeaderEl.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = 'claudian-status-panel-label';
    label.textContent = `Tasks (${completedCount}/${totalCount})`;
    this.todoHeaderEl.appendChild(label);

    // Collapsed-only elements: status indicator and current task preview
    if (!this.isTodoExpanded) {
      // Status indicator (tick only when all todos complete)
      if (completedCount === totalCount && totalCount > 0) {
        const status = document.createElement('span');
        status.className = 'claudian-status-panel-status status-completed';
        setIcon(status, 'check');
        this.todoHeaderEl.appendChild(status);
      }

      // Current task preview
      if (currentTask) {
        const current = document.createElement('span');
        current.className = 'claudian-status-panel-current';
        current.textContent = currentTask.activeForm;
        this.todoHeaderEl.appendChild(current);
      }
    }
  }

  /**
   * Render the expanded todo content.
   */
  private renderTodoContent(todos: TodoItem[]): void {
    if (!this.todoContentEl) return;
    renderTodoItems(this.todoContentEl, todos);
  }

  /**
   * Toggle todo expanded/collapsed state.
   */
  private toggleTodos(): void {
    this.isTodoExpanded = !this.isTodoExpanded;
    this.updateTodoDisplay();
  }

  /**
   * Update todo display based on expanded state.
   */
  private updateTodoDisplay(): void {
    if (!this.todoContentEl || !this.todoHeaderEl) return;

    // Show/hide content
    this.todoContentEl.style.display = this.isTodoExpanded ? 'block' : 'none';

    // Re-render header to update current task visibility
    if (this.currentTodos && this.currentTodos.length > 0) {
      const completedCount = this.currentTodos.filter(t => t.status === 'completed').length;
      const totalCount = this.currentTodos.length;
      const currentTask = this.currentTodos.find(t => t.status === 'in_progress');
      this.renderTodoHeader(completedCount, totalCount, currentTask);
      this.updateTodoAriaLabel(completedCount, totalCount);
    }

    this.scrollToBottom();
  }

  /**
   * Update todo ARIA label.
   */
  private updateTodoAriaLabel(completedCount: number, totalCount: number): void {
    if (!this.todoHeaderEl) return;

    const action = this.isTodoExpanded ? 'Collapse' : 'Expand';
    this.todoHeaderEl.setAttribute(
      'aria-label',
      `${action} task list - ${completedCount} of ${totalCount} completed`
    );
    this.todoHeaderEl.setAttribute('aria-expanded', String(this.isTodoExpanded));
  }

  /**
   * Scroll messages container to bottom.
   */
  private scrollToBottom(): void {
    if (this.containerEl) {
      this.containerEl.scrollTop = this.containerEl.scrollHeight;
    }
  }

  // ============================================
  // Async Subagent Status Methods
  // ============================================

  /**
   * Add or update an async subagent in the panel.
   */
  updateSubagent(info: PanelSubagentInfo): void {
    this.currentSubagents.set(info.id, info);
    this.renderSubagentStatus();
  }

  /**
   * Remove a subagent from the panel.
   */
  removeSubagent(id: string): void {
    this.currentSubagents.delete(id);
    this.renderSubagentStatus();
  }

  /**
   * Clear all subagents from the panel.
   */
  clearSubagents(): void {
    this.currentSubagents.clear();
    this.renderSubagentStatus();
  }

  /**
   * Clear completed/error/orphaned subagents from the panel.
   * Called when user sends a new query - done entries are dismissed.
   */
  clearTerminalSubagents(): void {
    for (const [id, info] of this.currentSubagents) {
      if (TERMINAL_STATES.includes(info.status)) {
        this.currentSubagents.delete(id);
      }
    }
    this.renderSubagentStatus();
  }

  /**
   * Check if all subagents completed successfully.
   * Used for auto-hide on response completion.
   * Returns false if empty or any subagent is pending, running, error, or orphaned.
   */
  areAllSubagentsCompleted(): boolean {
    if (this.currentSubagents.size === 0) return false;
    for (const info of this.currentSubagents.values()) {
      if (info.status !== 'completed') {
        return false;
      }
    }
    return true;
  }

  /**
   * Truncate description for display.
   */
  private truncateDescription(description: string, maxLength = 50): string {
    if (description.length <= maxLength) return description;
    return description.substring(0, maxLength) + '...';
  }

  /**
   * Format running task count text.
   */
  private formatRunningCount(count: number): string {
    const taskWord = count === 1 ? 'background task' : 'background tasks';
    return `${count} ${taskWord}`;
  }

  /**
   * Render the subagent status section.
   * - Completed tasks: show ✓ + description for each
   * - Running tasks: show "X background tasks" count
   */
  private renderSubagentStatus(): void {
    if (!this.subagentContainerEl) return;

    // Collect running and completed subagents
    const runningSubagents: PanelSubagentInfo[] = [];
    const completedSubagents: PanelSubagentInfo[] = [];

    for (const info of this.currentSubagents.values()) {
      switch (info.status) {
        case 'pending':
        case 'running':
          runningSubagents.push(info);
          break;
        case 'completed':
          completedSubagents.push(info);
          break;
        // Ignore error/orphaned - they don't show in panel
      }
    }

    // Hide if nothing to show
    if (runningSubagents.length === 0 && completedSubagents.length === 0) {
      this.subagentContainerEl.style.display = 'none';
      return;
    }

    this.subagentContainerEl.style.display = 'block';
    this.subagentContainerEl.empty();

    // If we have both done and running, render last done row with running on same line
    const lastDoneIndex = completedSubagents.length - 1;

    // Render completed subagents (each with ✓ + description)
    for (let i = 0; i < completedSubagents.length; i++) {
      const subagent = completedSubagents[i];
      const isLastDone = i === lastDoneIndex;
      const showRunningOnThisRow = isLastDone && runningSubagents.length > 0;

      const rowEl = document.createElement('div');
      rowEl.className = showRunningOnThisRow
        ? 'claudian-status-panel-done-row claudian-status-panel-combined-row'
        : 'claudian-status-panel-done-row';

      // Bot icon
      const botIconEl = document.createElement('span');
      botIconEl.className = 'claudian-status-panel-icon claudian-status-panel-bot-icon';
      setIcon(botIconEl, getToolIcon(TOOL_TASK));
      rowEl.appendChild(botIconEl);

      // Description text
      const textEl = document.createElement('span');
      textEl.className = 'claudian-status-panel-done-text';
      textEl.textContent = this.truncateDescription(subagent.description);
      rowEl.appendChild(textEl);

      // Green tick icon
      const iconEl = document.createElement('span');
      iconEl.className = 'claudian-status-panel-icon claudian-status-panel-done-icon';
      setIcon(iconEl, 'check');
      rowEl.appendChild(iconEl);

      // If last done row and we have running, add running count to the right
      if (showRunningOnThisRow) {
        const runningEl = document.createElement('span');
        runningEl.className = 'claudian-status-panel-running-text';
        runningEl.textContent = this.formatRunningCount(runningSubagents.length);
        rowEl.appendChild(runningEl);
      }

      this.subagentContainerEl.appendChild(rowEl);
    }

    // Render running count alone (only if no completed subagents)
    if (runningSubagents.length > 0 && completedSubagents.length === 0) {
      const rowEl = document.createElement('div');
      rowEl.className = 'claudian-status-panel-running-row';

      // Count text
      const textEl = document.createElement('span');
      textEl.className = 'claudian-status-panel-running-text';
      textEl.textContent = this.formatRunningCount(runningSubagents.length);
      rowEl.appendChild(textEl);

      this.subagentContainerEl.appendChild(rowEl);
    }

    this.scrollToBottom();
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Destroy the panel.
   */
  destroy(): void {
    // Remove event listeners before removing elements
    if (this.todoHeaderEl) {
      if (this.todoClickHandler) {
        this.todoHeaderEl.removeEventListener('click', this.todoClickHandler);
      }
      if (this.todoKeydownHandler) {
        this.todoHeaderEl.removeEventListener('keydown', this.todoKeydownHandler);
      }
    }
    this.todoClickHandler = null;
    this.todoKeydownHandler = null;

    // Clear subagent tracking
    this.currentSubagents.clear();

    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
    this.subagentContainerEl = null;
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.containerEl = null;
    this.currentTodos = null;
  }
}
