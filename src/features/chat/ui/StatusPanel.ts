/**
 * StatusPanel component.
 *
 * A persistent panel at the bottom of the messages area that shows
 * async subagents and todos (both collapsible).
 *
 * Flows seamlessly with the chat - no borders or backgrounds.
 */

import { setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools';
import type { AsyncSubagentStatus, SubagentInfo } from '../../../core/types';
import { renderTodoItems } from '../rendering/todoUtils';

/** Async subagent display info for the panel. */
export interface PanelSubagentInfo {
  id: string;
  description: string;
  status: AsyncSubagentStatus;
  prompt?: string;
  result?: string;
}

/** State for a panel subagent element. */
interface PanelSubagentState {
  wrapperEl: HTMLElement;
  headerEl: HTMLElement;
  contentEl: HTMLElement;
  isExpanded: boolean;
  clickHandler: () => void;
  keydownHandler: (e: KeyboardEvent) => void;
}

/** Callback when a panel subagent header is clicked. */
export type PanelSubagentClickCallback = (id: string) => void;

/**
 * StatusPanel - persistent bottom panel for async subagents and todos.
 */
export class StatusPanel {
  private containerEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;

  // Async subagent section (above todos)
  private subagentContainerEl: HTMLElement | null = null;
  private subagentStates: Map<string, PanelSubagentState> = new Map();
  private currentSubagents: Map<string, PanelSubagentInfo> = new Map();
  private onSubagentClick: PanelSubagentClickCallback | null = null;

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
   * Re-creates the panel structure and re-renders current subagents.
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
    this.cleanupSubagentStates();
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.createPanel();

    // Re-render current state
    this.renderAllSubagents();
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

    // Async subagent container (above todos)
    this.subagentContainerEl = document.createElement('div');
    this.subagentContainerEl.className = 'claudian-status-panel-subagents';
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
    setIcon(icon, 'list-checks');
    this.todoHeaderEl.appendChild(icon);

    // Label
    const label = document.createElement('span');
    label.className = 'claudian-status-panel-label';
    label.textContent = `Tasks (${completedCount}/${totalCount})`;
    this.todoHeaderEl.appendChild(label);

    // Current task (only when collapsed)
    if (!this.isTodoExpanded && currentTask) {
      const current = document.createElement('span');
      current.className = 'claudian-status-panel-current';
      current.textContent = currentTask.activeForm;
      this.todoHeaderEl.appendChild(current);
    }

    // Status indicator (tick only when all todos complete)
    const status = document.createElement('span');
    status.className = 'claudian-status-panel-status';
    if (completedCount === totalCount && totalCount > 0) {
      status.classList.add('status-completed');
      setIcon(status, 'check');
    }
    this.todoHeaderEl.appendChild(status);
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
  // Async Subagent Methods
  // ============================================

  /**
   * Set callback for when a panel subagent header is clicked.
   * Used to coordinate with inline renderer visibility.
   */
  setOnSubagentClick(callback: PanelSubagentClickCallback | null): void {
    this.onSubagentClick = callback;
  }

  /**
   * Add or update an async subagent in the panel.
   * Panel subagents are hidden by default - use showSubagent() to make visible.
   */
  updateSubagent(info: PanelSubagentInfo): void {
    this.currentSubagents.set(info.id, info);

    const existingState = this.subagentStates.get(info.id);
    if (existingState) {
      this.updateSubagentElement(existingState, info);
    } else {
      this.createSubagentElement(info);
    }
  }

  /**
   * Show a specific subagent in the panel.
   */
  showSubagent(id: string): void {
    const state = this.subagentStates.get(id);
    if (state) {
      state.wrapperEl.style.display = 'block';
      this.scrollToBottom();
    }
  }

  /**
   * Hide a specific subagent in the panel.
   */
  hideSubagent(id: string): void {
    const state = this.subagentStates.get(id);
    if (state) {
      state.wrapperEl.style.display = 'none';
    }
  }

  /**
   * Check if a subagent is visible in the panel.
   */
  isSubagentVisible(id: string): boolean {
    const state = this.subagentStates.get(id);
    return state ? state.wrapperEl.style.display !== 'none' : false;
  }

  /**
   * Remove a subagent from the panel (e.g., when completed and dismissed).
   */
  removeSubagent(id: string): void {
    this.cleanupSubagentState(id);
    this.currentSubagents.delete(id);
  }

  /**
   * Clear all subagents from the panel.
   */
  clearSubagents(): void {
    this.cleanupSubagentStates();
    this.currentSubagents.clear();
  }

  /**
   * Clear completed/error/orphaned subagents from the panel.
   * Called when user sends a new query - terminal subagents are dismissed.
   */
  clearTerminalSubagents(): void {
    const terminalStates: PanelSubagentInfo['status'][] = ['completed', 'error', 'orphaned'];

    for (const [id, info] of this.currentSubagents) {
      if (terminalStates.includes(info.status)) {
        this.cleanupSubagentState(id);
        this.currentSubagents.delete(id);
      }
    }
  }

  /**
   * Restore async subagents from loaded conversation messages.
   * Running/pending subagents are marked as orphaned since they can't be tracked after reload.
   * Panel subagents are created but hidden - inline renderers are shown first.
   */
  restoreSubagents(subagents: SubagentInfo[]): void {
    // Clear existing subagents first
    this.clearSubagents();

    // Filter to async subagents only
    const asyncSubagents = subagents.filter(s => s.mode === 'async');

    for (const subagent of asyncSubagents) {
      // Determine display status - running/pending become orphaned after reload
      let status: PanelSubagentInfo['status'];
      if (subagent.asyncStatus === 'completed') {
        status = 'completed';
      } else if (subagent.asyncStatus === 'error') {
        status = 'error';
      } else if (subagent.asyncStatus === 'orphaned') {
        status = 'orphaned';
      } else {
        // running or pending - can't track after reload, mark as orphaned
        status = 'orphaned';
      }

      this.updateSubagent({
        id: subagent.id,
        description: subagent.description,
        status,
        prompt: subagent.prompt,
        result: subagent.result,
      });
      // Keep hidden - inline renderer is shown first on restore
    }
  }

  /**
   * Create a subagent element in the panel.
   * Hidden by default - use showSubagent() to make visible.
   */
  private createSubagentElement(info: PanelSubagentInfo): void {
    if (!this.subagentContainerEl) return;

    const wrapperEl = document.createElement('div');
    wrapperEl.className = `claudian-subagent-list async ${info.status}`;
    wrapperEl.dataset.panelSubagentId = info.id;
    // Hidden by default - inline renderer is shown first
    wrapperEl.style.display = 'none';

    // Header (collapsible)
    const headerEl = document.createElement('div');
    headerEl.className = 'claudian-subagent-header';
    headerEl.setAttribute('tabindex', '0');
    headerEl.setAttribute('role', 'button');
    headerEl.setAttribute('aria-expanded', 'false');

    // Robot icon
    const iconEl = document.createElement('div');
    iconEl.className = 'claudian-subagent-icon';
    setIcon(iconEl, 'bot');
    headerEl.appendChild(iconEl);

    // Label
    const labelEl = document.createElement('div');
    labelEl.className = 'claudian-subagent-label';
    labelEl.textContent = this.truncateDescription(info.description);
    headerEl.appendChild(labelEl);

    // Status text
    const statusTextEl = document.createElement('div');
    statusTextEl.className = 'claudian-subagent-status-text';
    statusTextEl.textContent = this.getStatusText(info.status);
    headerEl.appendChild(statusTextEl);

    // Status indicator icon
    const statusEl = document.createElement('div');
    statusEl.className = `claudian-subagent-status status-${info.status}`;
    if (info.status === 'completed') {
      setIcon(statusEl, 'check');
    } else if (info.status === 'error') {
      setIcon(statusEl, 'x');
    } else if (info.status === 'orphaned') {
      setIcon(statusEl, 'alert-circle');
    }
    headerEl.appendChild(statusEl);

    wrapperEl.appendChild(headerEl);

    // Content area (collapsed by default)
    const contentEl = document.createElement('div');
    contentEl.className = 'claudian-subagent-content';
    contentEl.style.display = 'none';
    this.renderSubagentContent(contentEl, info);
    wrapperEl.appendChild(contentEl);

    // Create state object
    const state: PanelSubagentState = {
      wrapperEl,
      headerEl,
      contentEl,
      isExpanded: false,
      clickHandler: () => this.toggleSubagent(info.id),
      keydownHandler: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggleSubagent(info.id);
        }
      },
    };

    // Attach event handlers
    headerEl.addEventListener('click', state.clickHandler);
    headerEl.addEventListener('keydown', state.keydownHandler);

    this.subagentContainerEl.appendChild(wrapperEl);
    this.subagentStates.set(info.id, state);
  }

  /**
   * Render content for a panel subagent (prompt or DONE/ERROR).
   */
  private renderSubagentContent(contentEl: HTMLElement, info: PanelSubagentInfo): void {
    contentEl.empty();

    const rowEl = document.createElement('div');
    rowEl.className = 'claudian-subagent-done';
    const textEl = document.createElement('div');
    textEl.className = 'claudian-subagent-done-text';

    if (info.status === 'completed') {
      textEl.textContent = 'DONE';
    } else if (info.status === 'error') {
      textEl.textContent = 'ERROR';
    } else if (info.status === 'orphaned') {
      textEl.textContent = 'Task orphaned';
    } else {
      // Running/pending - show prompt
      textEl.textContent = this.truncatePrompt(info.prompt || 'Background task');
      textEl.classList.add('claudian-async-prompt');
    }

    rowEl.appendChild(textEl);
    contentEl.appendChild(rowEl);
  }

  /**
   * Toggle a panel subagent's expanded/collapsed state.
   */
  private toggleSubagent(id: string): void {
    const state = this.subagentStates.get(id);
    if (!state) return;

    state.isExpanded = !state.isExpanded;
    if (state.isExpanded) {
      state.wrapperEl.classList.add('expanded');
      state.contentEl.style.display = 'block';
      state.headerEl.setAttribute('aria-expanded', 'true');
    } else {
      state.wrapperEl.classList.remove('expanded');
      state.contentEl.style.display = 'none';
      state.headerEl.setAttribute('aria-expanded', 'false');
    }

    this.scrollToBottom();
  }

  /**
   * Truncate prompt for display.
   */
  private truncatePrompt(prompt: string, maxLength = 200): string {
    if (!prompt) return '';
    if (prompt.length <= maxLength) return prompt;
    return prompt.substring(0, maxLength) + '...';
  }

  /**
   * Update an existing subagent element.
   */
  private updateSubagentElement(state: PanelSubagentState, info: PanelSubagentInfo): void {
    const { wrapperEl, contentEl } = state;

    // Update wrapper class for status (preserve display and expanded state)
    const wasExpanded = state.isExpanded;
    wrapperEl.className = `claudian-subagent-list async ${info.status}`;
    if (wasExpanded) {
      wrapperEl.classList.add('expanded');
    }
    if (info.status === 'completed') {
      wrapperEl.classList.add('done');
    } else if (info.status === 'error' || info.status === 'orphaned') {
      wrapperEl.classList.add('error');
    }

    // Update label
    const labelEl = wrapperEl.querySelector('.claudian-subagent-label');
    if (labelEl) {
      labelEl.textContent = this.truncateDescription(info.description);
    }

    // Update status text
    const statusTextEl = wrapperEl.querySelector('.claudian-subagent-status-text');
    if (statusTextEl) {
      statusTextEl.textContent = this.getStatusText(info.status);
    }

    // Update status icon
    const statusEl = wrapperEl.querySelector('.claudian-subagent-status');
    if (statusEl) {
      statusEl.className = `claudian-subagent-status status-${info.status}`;
      statusEl.innerHTML = '';
      if (info.status === 'completed') {
        setIcon(statusEl as HTMLElement, 'check');
      } else if (info.status === 'error') {
        setIcon(statusEl as HTMLElement, 'x');
      } else if (info.status === 'orphaned') {
        setIcon(statusEl as HTMLElement, 'alert-circle');
      }
    }

    // Update content
    this.renderSubagentContent(contentEl, info);
  }

  /**
   * Re-render all subagents (after remount).
   * Preserves visibility state - hidden subagents stay hidden.
   */
  private renderAllSubagents(): void {
    // Store visibility state before clearing
    const visibilityStates = new Map<string, boolean>();
    for (const [id, state] of this.subagentStates) {
      visibilityStates.set(id, state.wrapperEl.style.display !== 'none');
    }

    this.subagentStates.clear();
    for (const [id, info] of this.currentSubagents) {
      this.createSubagentElement(info);
      // Restore visibility state
      if (visibilityStates.get(id)) {
        this.showSubagent(id);
      }
    }
  }

  /**
   * Cleanup a single subagent state (remove listeners and element).
   */
  private cleanupSubagentState(id: string): void {
    const state = this.subagentStates.get(id);
    if (state) {
      state.headerEl.removeEventListener('click', state.clickHandler);
      state.headerEl.removeEventListener('keydown', state.keydownHandler);
      state.wrapperEl.remove();
      this.subagentStates.delete(id);
    }
  }

  /**
   * Cleanup all subagent states (remove listeners and elements).
   */
  private cleanupSubagentStates(): void {
    for (const state of this.subagentStates.values()) {
      state.headerEl.removeEventListener('click', state.clickHandler);
      state.headerEl.removeEventListener('keydown', state.keydownHandler);
      state.wrapperEl.remove();
    }
    this.subagentStates.clear();
  }

  /**
   * Get status display text.
   */
  private getStatusText(status: PanelSubagentInfo['status']): string {
    switch (status) {
      case 'pending': return 'Initializing';
      case 'running': return 'Running in background';
      case 'completed': return '';
      case 'error': return 'Error';
      case 'orphaned': return 'Orphaned';
    }
  }

  /**
   * Truncate description for display.
   */
  private truncateDescription(description: string, maxLength = 40): string {
    if (description.length <= maxLength) return description;
    return description.substring(0, maxLength) + '...';
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

    // Cleanup subagent states (removes event listeners)
    this.cleanupSubagentStates();
    this.currentSubagents.clear();
    this.onSubagentClick = null;

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
