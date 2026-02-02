import { setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools';
import { getToolIcon, TOOL_TASK, TOOL_TODO_WRITE } from '../../../core/tools';
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

/** Bash output display info for the panel. */
export interface PanelBashOutput {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'error';
  output: string;
  exitCode?: number;
}

const MAX_BASH_OUTPUTS = 50;

/**
 * StatusPanel - persistent bottom panel for async subagent status and todos.
 */
export class StatusPanel {
  private containerEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;

  // Async subagent section (above todos)
  private subagentContainerEl: HTMLElement | null = null;
  private currentSubagents: Map<string, PanelSubagentInfo> = new Map();

  // Bash output section (between subagents and todos)
  private bashOutputContainerEl: HTMLElement | null = null;
  private bashHeaderEl: HTMLElement | null = null;
  private bashContentEl: HTMLElement | null = null;
  private isBashExpanded = true;
  private currentBashOutputs: Map<string, PanelBashOutput> = new Map();

  // Todo section
  private todoContainerEl: HTMLElement | null = null;
  private todoHeaderEl: HTMLElement | null = null;
  private todoContentEl: HTMLElement | null = null;
  private isTodoExpanded = false;
  private currentTodos: TodoItem[] | null = null;

  // Event handler references for cleanup
  private todoClickHandler: (() => void) | null = null;
  private todoKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private bashClickHandler: (() => void) | null = null;
  private bashKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

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

    if (this.bashHeaderEl) {
      if (this.bashClickHandler) {
        this.bashHeaderEl.removeEventListener('click', this.bashClickHandler);
      }
      if (this.bashKeydownHandler) {
        this.bashHeaderEl.removeEventListener('keydown', this.bashKeydownHandler);
      }
    }
    this.bashClickHandler = null;
    this.bashKeydownHandler = null;

    // Remove old panel from DOM
    if (this.panelEl) {
      this.panelEl.remove();
    }

    // Clear references and recreate
    this.panelEl = null;
    this.subagentContainerEl = null;
    this.bashOutputContainerEl = null;
    this.bashHeaderEl = null;
    this.bashContentEl = null;
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.createPanel();

    // Re-render current state
    this.renderSubagentStatus();
    this.renderBashOutputs();
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

    // Bash output container (between subagents and todos) - hidden by default
    this.bashOutputContainerEl = document.createElement('div');
    this.bashOutputContainerEl.className = 'claudian-status-panel-bash';
    this.bashOutputContainerEl.style.display = 'none';

    this.bashHeaderEl = document.createElement('div');
    this.bashHeaderEl.className = 'claudian-tool-header claudian-status-panel-bash-header';
    this.bashHeaderEl.setAttribute('tabindex', '0');
    this.bashHeaderEl.setAttribute('role', 'button');

    this.bashClickHandler = () => this.toggleBashSection();
    this.bashKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleBashSection();
      }
    };
    this.bashHeaderEl.addEventListener('click', this.bashClickHandler);
    this.bashHeaderEl.addEventListener('keydown', this.bashKeydownHandler);

    this.bashContentEl = document.createElement('div');
    this.bashContentEl.className = 'claudian-status-panel-bash-content';

    this.bashOutputContainerEl.appendChild(this.bashHeaderEl);
    this.bashOutputContainerEl.appendChild(this.bashContentEl);
    this.panelEl.appendChild(this.bashOutputContainerEl);

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
  // Bash Output Methods
  // ============================================

  addBashOutput(info: PanelBashOutput): void {
    this.currentBashOutputs.set(info.id, info);
    while (this.currentBashOutputs.size > MAX_BASH_OUTPUTS) {
      const oldest = this.currentBashOutputs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.currentBashOutputs.delete(oldest);
    }
    this.renderBashOutputs();
  }

  updateBashOutput(id: string, updates: Partial<PanelBashOutput>): void {
    const existing = this.currentBashOutputs.get(id);
    if (!existing) return;
    this.currentBashOutputs.set(id, { ...existing, ...updates });
    this.renderBashOutputs();
  }

  clearBashOutputs(): void {
    this.currentBashOutputs.clear();
    this.renderBashOutputs();
  }

  private renderBashOutputs(): void {
    if (!this.bashOutputContainerEl || !this.bashHeaderEl || !this.bashContentEl) return;

    if (this.currentBashOutputs.size === 0) {
      this.bashOutputContainerEl.style.display = 'none';
      return;
    }

    this.bashOutputContainerEl.style.display = 'block';
    this.bashHeaderEl.empty();
    this.bashContentEl.empty();

    const headerIconEl = document.createElement('span');
    headerIconEl.className = 'claudian-tool-icon';
    headerIconEl.setAttribute('aria-hidden', 'true');
    setIcon(headerIconEl, 'terminal');
    this.bashHeaderEl.appendChild(headerIconEl);

    const latest = Array.from(this.currentBashOutputs.values()).at(-1);

    const headerLabelEl = document.createElement('span');
    headerLabelEl.className = 'claudian-tool-label';
    if (this.isBashExpanded) {
      headerLabelEl.textContent = 'Command panel';
    } else {
      headerLabelEl.textContent = latest ? this.truncateDescription(latest.command, 60) : 'Command panel';
    }
    this.bashHeaderEl.appendChild(headerLabelEl);

    const previewEl = document.createElement('span');
    previewEl.className = 'claudian-tool-current';
    previewEl.style.display = this.isBashExpanded ? '' : 'none';
    this.bashHeaderEl.appendChild(previewEl);

    const summaryStatusEl = document.createElement('span');
    summaryStatusEl.className = 'claudian-tool-status';
    if (!this.isBashExpanded && latest) {
      summaryStatusEl.classList.add(`status-${latest.status}`);
      summaryStatusEl.setAttribute('aria-label', `Status: ${latest.status}`);
      if (latest.status === 'completed') setIcon(summaryStatusEl, 'check');
      if (latest.status === 'error') setIcon(summaryStatusEl, 'x');
    } else {
      summaryStatusEl.style.display = 'none';
    }
    this.bashHeaderEl.appendChild(summaryStatusEl);

    const actionsEl = document.createElement('span');
    actionsEl.className = 'claudian-status-panel-bash-actions';

    const clearEl = document.createElement('span');
    clearEl.className = 'claudian-status-panel-bash-action';
    clearEl.setAttribute('role', 'button');
    clearEl.setAttribute('tabindex', '0');
    clearEl.setAttribute('aria-label', 'Clear bash output');
    setIcon(clearEl, 'trash');
    clearEl.addEventListener('click', (e) => {
      (e as any).stopPropagation?.();
      this.clearBashOutputs();
    });
    clearEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.clearBashOutputs();
      }
    });
    actionsEl.appendChild(clearEl);

    this.bashHeaderEl.appendChild(actionsEl);

    this.bashContentEl.style.display = this.isBashExpanded ? 'block' : 'none';

    if (!this.isBashExpanded) {
      return;
    }

    for (const info of this.currentBashOutputs.values()) {
      const entryEl = document.createElement('div');
      entryEl.className = 'claudian-tool-call claudian-status-panel-bash-entry';

      const entryHeaderEl = document.createElement('div');
      entryHeaderEl.className = 'claudian-tool-header';

      const entryIconEl = document.createElement('span');
      entryIconEl.className = 'claudian-tool-icon';
      entryIconEl.setAttribute('aria-hidden', 'true');
      setIcon(entryIconEl, 'terminal');
      entryHeaderEl.appendChild(entryIconEl);

      const entryLabelEl = document.createElement('span');
      entryLabelEl.className = 'claudian-tool-label';
      entryLabelEl.textContent = `Bash: ${this.truncateDescription(info.command, 60)}`;
      entryHeaderEl.appendChild(entryLabelEl);

      const entryStatusEl = document.createElement('span');
      entryStatusEl.className = 'claudian-tool-status';
      entryStatusEl.classList.add(`status-${info.status}`);
      entryStatusEl.setAttribute('aria-label', `Status: ${info.status}`);
      if (info.status === 'completed') setIcon(entryStatusEl, 'check');
      if (info.status === 'error') setIcon(entryStatusEl, 'x');
      entryHeaderEl.appendChild(entryStatusEl);

      entryEl.appendChild(entryHeaderEl);

      const contentEl = document.createElement('div');
      contentEl.className = 'claudian-tool-content';

      const rowEl = document.createElement('div');
      rowEl.className = 'claudian-tool-result-row';

      const textEl = document.createElement('span');
      textEl.className = 'claudian-tool-result-text';
      if (info.status === 'running' && !info.output) {
        textEl.textContent = 'Running...';
      } else if (info.output) {
        textEl.textContent = info.output;
      } else {
        textEl.textContent = '';
      }

      rowEl.appendChild(textEl);
      contentEl.appendChild(rowEl);

      entryEl.appendChild(contentEl);
      this.bashContentEl.appendChild(entryEl);
    }

    this.scrollToBottom();
  }

  private toggleBashSection(): void {
    this.isBashExpanded = !this.isBashExpanded;
    this.renderBashOutputs();
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

    if (this.bashHeaderEl) {
      if (this.bashClickHandler) {
        this.bashHeaderEl.removeEventListener('click', this.bashClickHandler);
      }
      if (this.bashKeydownHandler) {
        this.bashHeaderEl.removeEventListener('keydown', this.bashKeydownHandler);
      }
    }
    this.bashClickHandler = null;
    this.bashKeydownHandler = null;

    // Clear subagent and bash output tracking
    this.currentSubagents.clear();
    this.currentBashOutputs.clear();

    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
    this.subagentContainerEl = null;
    this.bashOutputContainerEl = null;
    this.bashHeaderEl = null;
    this.bashContentEl = null;
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.containerEl = null;
    this.currentTodos = null;
  }
}
