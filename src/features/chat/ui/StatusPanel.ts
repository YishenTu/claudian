import { Notice, setIcon } from 'obsidian';

import type { TodoItem } from '../../../core/tools/todo';
import { getToolIcon } from '../../../core/tools/toolIcons';
import { TOOL_TODO_WRITE } from '../../../core/tools/toolNames';
import { t } from '../../../i18n/i18n';
import { renderTodoItems } from '../rendering/todoUtils';

export interface PanelBashOutput {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'error';
  output: string;
  exitCode?: number;
}

const MAX_BASH_OUTPUTS = 50;

/**
 * StatusPanel - persistent bottom panel for todos and command output.
 */
export class StatusPanel {
  private containerEl: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;

  // Bash output section
  private bashOutputContainerEl: HTMLElement | null = null;
  private bashHeaderEl: HTMLElement | null = null;
  private bashContentEl: HTMLElement | null = null;
  private isBashExpanded = true;
  private currentBashOutputs: Map<string, PanelBashOutput> = new Map();
  private bashEntryExpanded: Map<string, boolean> = new Map();

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
    this.bashOutputContainerEl = null;
    this.bashHeaderEl = null;
    this.bashContentEl = null;
    this.todoContainerEl = null;
    this.todoHeaderEl = null;
    this.todoContentEl = null;
    this.createPanel();

    // Re-render current state
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

    // Bash output container - hidden by default
    this.bashOutputContainerEl = document.createElement('div');
    this.bashOutputContainerEl.className = 'claudian-status-panel-bash claudian-hidden';

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
    this.todoContainerEl.className = 'claudian-status-panel-todos claudian-hidden';
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
    this.todoContentEl.className = 'claudian-status-panel-content claudian-todo-list-container claudian-hidden';
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
      this.todoContainerEl.addClass('claudian-hidden');
      this.todoHeaderEl.empty();
      this.todoContentEl.empty();
      return;
    }

    this.todoContainerEl.removeClass('claudian-hidden');

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
    this.todoContentEl.toggleClass('claudian-hidden', !this.isTodoExpanded);

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
  // Bash Output Methods
  // ============================================

  private truncateDescription(description: string, maxLength = 50): string {
    if (description.length <= maxLength) return description;
    return description.substring(0, maxLength) + '...';
  }

  addBashOutput(info: PanelBashOutput): void {
    this.currentBashOutputs.set(info.id, info);
    while (this.currentBashOutputs.size > MAX_BASH_OUTPUTS) {
      const oldest = this.currentBashOutputs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.currentBashOutputs.delete(oldest);
      this.bashEntryExpanded.delete(oldest);
    }
    this.renderBashOutputs();
  }

  updateBashOutput(id: string, updates: Partial<Omit<PanelBashOutput, 'id' | 'command'>>): void {
    const existing = this.currentBashOutputs.get(id);
    if (!existing) return;
    this.currentBashOutputs.set(id, { ...existing, ...updates });
    this.renderBashOutputs();
  }

  clearBashOutputs(): void {
    this.currentBashOutputs.clear();
    this.bashEntryExpanded.clear();
    this.renderBashOutputs();
  }

  private renderBashOutputs(options: { scroll?: boolean } = {}): void {
    if (!this.bashOutputContainerEl || !this.bashHeaderEl || !this.bashContentEl) return;
    const scroll = options.scroll ?? true;

    if (this.currentBashOutputs.size === 0) {
      this.bashOutputContainerEl.addClass('claudian-hidden');
      return;
    }

    this.bashOutputContainerEl.removeClass('claudian-hidden');
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
      headerLabelEl.textContent = t('chat.bangBash.commandPanel');
    } else {
      headerLabelEl.textContent = latest ? this.truncateDescription(latest.command, 60) : t('chat.bangBash.commandPanel');
    }
    this.bashHeaderEl.appendChild(headerLabelEl);

    const previewEl = document.createElement('span');
    previewEl.className = 'claudian-tool-current';
    previewEl.classList.toggle('claudian-hidden', !this.isBashExpanded);
    this.bashHeaderEl.appendChild(previewEl);

    const summaryStatusEl = document.createElement('span');
    summaryStatusEl.className = 'claudian-tool-status';
    if (!this.isBashExpanded && latest) {
      summaryStatusEl.classList.add(`status-${latest.status}`);
      summaryStatusEl.setAttribute('aria-label', t('chat.bangBash.statusLabel', { status: latest.status }));
      if (latest.status === 'completed') setIcon(summaryStatusEl, 'check');
      if (latest.status === 'error') setIcon(summaryStatusEl, 'x');
    } else {
      summaryStatusEl.classList.add('claudian-hidden');
    }
    this.bashHeaderEl.appendChild(summaryStatusEl);

    this.bashHeaderEl.setAttribute('aria-expanded', String(this.isBashExpanded));

    const actionsEl = document.createElement('span');
    actionsEl.className = 'claudian-status-panel-bash-actions';
    this.appendActionButton(actionsEl, 'copy', t('chat.bangBash.copyAriaLabel'), 'copy', () => {
      void this.copyLatestBashOutput();
    });
    this.appendActionButton(actionsEl, 'clear', t('chat.bangBash.clearAriaLabel'), 'trash', () => {
      this.clearBashOutputs();
    });
    this.bashHeaderEl.appendChild(actionsEl);

    this.bashContentEl.toggleClass('claudian-hidden', !this.isBashExpanded);

    if (!this.isBashExpanded) {
      return;
    }

    for (const info of this.currentBashOutputs.values()) {
      this.bashContentEl.appendChild(this.renderBashEntry(info));
    }

    if (scroll) {
      this.bashContentEl.scrollTop = this.bashContentEl.scrollHeight;
      this.scrollToBottom();
    }
  }

  private renderBashEntry(info: PanelBashOutput): HTMLElement {
    const entryEl = document.createElement('div');
    entryEl.className = 'claudian-tool-call claudian-status-panel-bash-entry';

    const entryHeaderEl = document.createElement('div');
    entryHeaderEl.className = 'claudian-tool-header';
    entryHeaderEl.setAttribute('tabindex', '0');
    entryHeaderEl.setAttribute('role', 'button');

    const entryIconEl = document.createElement('span');
    entryIconEl.className = 'claudian-tool-icon';
    entryIconEl.setAttribute('aria-hidden', 'true');
    setIcon(entryIconEl, 'dollar-sign');
    entryHeaderEl.appendChild(entryIconEl);

    const entryLabelEl = document.createElement('span');
    entryLabelEl.className = 'claudian-tool-label';
    entryLabelEl.textContent = t('chat.bangBash.commandLabel', { command: this.truncateDescription(info.command, 60) });
    entryHeaderEl.appendChild(entryLabelEl);

    const entryStatusEl = document.createElement('span');
    entryStatusEl.className = 'claudian-tool-status';
    entryStatusEl.classList.add(`status-${info.status}`);
    entryStatusEl.setAttribute('aria-label', t('chat.bangBash.statusLabel', { status: info.status }));
    if (info.status === 'completed') setIcon(entryStatusEl, 'check');
    if (info.status === 'error') setIcon(entryStatusEl, 'x');
    entryHeaderEl.appendChild(entryStatusEl);

    entryEl.appendChild(entryHeaderEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'claudian-tool-content';
    const isEntryExpanded = this.bashEntryExpanded.get(info.id) ?? true;
    contentEl.classList.toggle('claudian-hidden', !isEntryExpanded);
    entryHeaderEl.setAttribute('aria-expanded', String(isEntryExpanded));
    entryHeaderEl.setAttribute('aria-label', isEntryExpanded ? t('chat.bangBash.collapseOutput') : t('chat.bangBash.expandOutput'));
    entryHeaderEl.addEventListener('click', () => {
      this.bashEntryExpanded.set(info.id, !isEntryExpanded);
      this.renderBashOutputs({ scroll: false });
    });
    entryHeaderEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.bashEntryExpanded.set(info.id, !isEntryExpanded);
        this.renderBashOutputs({ scroll: false });
      }
    });

    const rowEl = document.createElement('div');
    rowEl.className = 'claudian-tool-result-row';

    const textEl = document.createElement('span');
    textEl.className = 'claudian-tool-result-text';
    if (info.status === 'running' && !info.output) {
      textEl.textContent = t('chat.bangBash.running');
    } else if (info.output) {
      textEl.textContent = info.output;
    }

    rowEl.appendChild(textEl);
    contentEl.appendChild(rowEl);

    entryEl.appendChild(contentEl);
    return entryEl;
  }

  private async copyLatestBashOutput(): Promise<void> {
    const latest = Array.from(this.currentBashOutputs.values()).at(-1);
    if (!latest) return;

    const output = latest.output?.trim() || (latest.status === 'running' ? t('chat.bangBash.running') : '');
    const text = output ? `$ ${latest.command}\n${output}` : `$ ${latest.command}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      new Notice(t('chat.bangBash.copyFailed'));
    }
  }

  private appendActionButton(
    parent: HTMLElement,
    name: string,
    ariaLabel: string,
    icon: string,
    action: () => void
  ): void {
    const el = document.createElement('span');
    el.className = `claudian-status-panel-bash-action claudian-status-panel-bash-action-${name}`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', ariaLabel);
    setIcon(el, icon);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        action();
      }
    });
    parent.appendChild(el);
  }

  private toggleBashSection(): void {
    this.isBashExpanded = !this.isBashExpanded;
    this.renderBashOutputs({ scroll: false });
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

    // Clear bash output tracking
    this.currentBashOutputs.clear();

    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
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
