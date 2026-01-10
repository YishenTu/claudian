/**
 * Claudian - MCP Test Modal
 *
 * Modal for displaying MCP server connection test results.
 */

import type { App } from 'obsidian';
import { Modal, Notice, setIcon } from 'obsidian';

import type { McpTestResult, McpTool } from '../../../core/mcp/McpTester';

/** Format error for user-friendly display. */
function formatToggleError(error: unknown): string {
  if (!(error instanceof Error)) return 'Failed to update tool setting';

  const msg = error.message.toLowerCase();
  if (msg.includes('permission') || msg.includes('eacces')) {
    return 'Permission denied. Check .claude/ folder permissions.';
  }
  if (msg.includes('enospc') || msg.includes('disk full') || msg.includes('no space')) {
    return 'Disk full. Free up space and try again.';
  }
  if (msg.includes('json') || msg.includes('syntax')) {
    return 'Config file corrupted. Check .claude/mcp.json';
  }
  return error.message || 'Failed to update tool setting';
}

/** Modal for displaying MCP test results. */
export class McpTestModal extends Modal {
  private serverName: string;
  private result: McpTestResult | null = null;
  private loading = true;
  private contentEl_: HTMLElement | null = null;
  private disabledTools: Set<string>;
  private onToolToggle?: (toolName: string, enabled: boolean) => Promise<void>;
  private onBulkToggle?: (disabledTools: string[]) => Promise<void>;
  private toolToggles: Map<string, { checkbox: HTMLInputElement; container: HTMLElement }> =
    new Map();
  private toolElements: Map<string, HTMLElement> = new Map();
  private toggleAllBtn: HTMLButtonElement | null = null;
  private pendingToggle = false;

  constructor(
    app: App,
    serverName: string,
    initialDisabledTools?: string[],
    onToolToggle?: (toolName: string, enabled: boolean) => Promise<void>,
    onBulkToggle?: (disabledTools: string[]) => Promise<void>
  ) {
    super(app);
    this.serverName = serverName;
    this.disabledTools = new Set(
      (initialDisabledTools ?? [])
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
    );
    this.onToolToggle = onToolToggle;
    this.onBulkToggle = onBulkToggle;
  }

  onOpen() {
    this.setTitle(`Verify: ${this.serverName}`);
    this.modalEl.addClass('claudian-mcp-test-modal');
    this.contentEl_ = this.contentEl;
    this.renderLoading();
  }

  /** Set the test result and update the display. */
  setResult(result: McpTestResult) {
    this.result = result;
    this.loading = false;
    this.render();
  }

  /** Set error state. */
  setError(error: string) {
    this.result = { success: false, tools: [], error };
    this.loading = false;
    this.render();
  }

  private renderLoading() {
    if (!this.contentEl_) return;
    this.contentEl_.empty();

    const loadingEl = this.contentEl_.createDiv({ cls: 'claudian-mcp-test-loading' });

    const spinnerEl = loadingEl.createDiv({ cls: 'claudian-mcp-test-spinner' });
    spinnerEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </svg>`;

    loadingEl.createSpan({ text: 'Connecting to MCP server...' });
  }

  private render() {
    if (!this.contentEl_) return;
    this.contentEl_.empty();

    if (!this.result) {
      this.renderLoading();
      return;
    }

    // Status section
    const statusEl = this.contentEl_.createDiv({ cls: 'claudian-mcp-test-status' });

    const iconEl = statusEl.createSpan({ cls: 'claudian-mcp-test-icon' });
    if (this.result.success) {
      setIcon(iconEl, 'check-circle');
      iconEl.addClass('success');
    } else {
      setIcon(iconEl, 'x-circle');
      iconEl.addClass('error');
    }

    const textEl = statusEl.createSpan({ cls: 'claudian-mcp-test-text' });
    if (this.result.success) {
      let statusText = 'Connected successfully';
      if (this.result.serverName) {
        statusText += ` to ${this.result.serverName}`;
        if (this.result.serverVersion) {
          statusText += ` v${this.result.serverVersion}`;
        }
      }
      textEl.setText(statusText);
    } else {
      textEl.setText('Connection failed');
    }

    // Error message
    if (this.result.error) {
      const errorEl = this.contentEl_.createDiv({ cls: 'claudian-mcp-test-error' });
      errorEl.setText(this.result.error);
    }

    // Tools section
    this.toolToggles.clear();
    this.toolElements.clear();

    if (this.result.tools.length > 0) {
      const toolsSection = this.contentEl_.createDiv({ cls: 'claudian-mcp-test-tools' });

      const toolsHeader = toolsSection.createDiv({ cls: 'claudian-mcp-test-tools-header' });
      toolsHeader.setText(`Available Tools (${this.result.tools.length})`);

      const toolsList = toolsSection.createDiv({ cls: 'claudian-mcp-test-tools-list' });

      for (const tool of this.result.tools) {
        this.renderTool(toolsList, tool);
      }
    } else if (this.result.success) {
      const noToolsEl = this.contentEl_.createDiv({ cls: 'claudian-mcp-test-no-tools' });
      noToolsEl.setText('No tools information available. Tools will be loaded when used in chat.');
    }

    // Button container
    const buttonContainer = this.contentEl_.createDiv({ cls: 'claudian-mcp-test-buttons' });

    // Toggle all button (only show if there are tools and toggle callback exists)
    if (this.result.tools.length > 0 && this.onToolToggle) {
      this.toggleAllBtn = buttonContainer.createEl('button', {
        cls: 'claudian-mcp-toggle-all-btn',
      });
      this.updateToggleAllButton();
      this.toggleAllBtn.addEventListener('click', () => this.handleToggleAll());
    }

    // Close button
    const closeBtn = buttonContainer.createEl('button', {
      text: 'Close',
      cls: 'mod-cta',
    });
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderTool(container: HTMLElement, tool: McpTool) {
    const toolEl = container.createDiv({ cls: 'claudian-mcp-test-tool' });

    const headerEl = toolEl.createDiv({ cls: 'claudian-mcp-test-tool-header' });

    const iconEl = headerEl.createSpan({ cls: 'claudian-mcp-test-tool-icon' });
    setIcon(iconEl, 'wrench');

    const nameEl = headerEl.createSpan({ cls: 'claudian-mcp-test-tool-name' });
    nameEl.setText(tool.name);

    // Obsidian-style toggle
    const toggleEl = headerEl.createDiv({ cls: 'claudian-mcp-test-tool-toggle' });
    const toggleContainer = toggleEl.createDiv({ cls: 'checkbox-container' });
    const checkbox = toggleContainer.createEl('input', {
      type: 'checkbox',
      attr: { tabindex: '0' },
    });

    const isEnabled = !this.disabledTools.has(tool.name);
    checkbox.checked = isEnabled;
    toggleContainer.toggleClass('is-enabled', isEnabled);
    this.updateToolState(toolEl, isEnabled);

    // Store references for toggle all
    this.toolToggles.set(tool.name, { checkbox, container: toggleContainer });
    this.toolElements.set(tool.name, toolEl);

    if (!this.onToolToggle) {
      checkbox.disabled = true;
    } else {
      // Handle clicks on the container (more reliable than checkbox change event)
      toggleContainer.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (checkbox.disabled) return;
        // Manually toggle the checkbox and call handler
        checkbox.checked = !checkbox.checked;
        this.handleToolToggle(tool.name, checkbox, toggleContainer);
      });
    }

    if (tool.description) {
      const descEl = toolEl.createDiv({ cls: 'claudian-mcp-test-tool-desc' });
      descEl.setText(tool.description);
    }
  }

  private async handleToolToggle(
    toolName: string,
    checkbox: HTMLInputElement,
    container: HTMLElement
  ) {
    const toolEl = this.toolElements.get(toolName);
    if (!toolEl) return;

    const wasDisabled = this.disabledTools.has(toolName);
    const nextDisabled = !checkbox.checked;

    if (nextDisabled) {
      this.disabledTools.add(toolName);
    } else {
      this.disabledTools.delete(toolName);
    }

    container.toggleClass('is-enabled', !nextDisabled);
    this.updateToolState(toolEl, !nextDisabled);
    this.updateToggleAllButton();
    checkbox.disabled = true;

    try {
      await this.onToolToggle?.(toolName, !nextDisabled);
    } catch (error) {
      // Rollback
      if (nextDisabled) {
        this.disabledTools.delete(toolName);
      } else {
        this.disabledTools.add(toolName);
      }
      checkbox.checked = !wasDisabled;
      container.toggleClass('is-enabled', !wasDisabled);
      this.updateToolState(toolEl, !wasDisabled);
      this.updateToggleAllButton();
      new Notice(formatToggleError(error));
    } finally {
      checkbox.disabled = false;
    }
  }

  private updateToolState(toolEl: HTMLElement, enabled: boolean) {
    toolEl.toggleClass('claudian-mcp-test-tool-disabled', !enabled);
  }

  private updateToggleAllButton() {
    if (!this.toggleAllBtn || !this.result) return;

    const allEnabled = this.disabledTools.size === 0;
    const allDisabled = this.disabledTools.size === this.result.tools.length;

    if (allEnabled) {
      this.toggleAllBtn.setText('Disable All');
      this.toggleAllBtn.toggleClass('is-destructive', true);
    } else {
      this.toggleAllBtn.setText(allDisabled ? 'Enable All' : 'Enable All');
      this.toggleAllBtn.toggleClass('is-destructive', false);
    }
  }

  private async handleToggleAll() {
    if (!this.result || this.pendingToggle || !this.onBulkToggle) return;

    const allEnabled = this.disabledTools.size === 0;
    const previousDisabled = new Set(this.disabledTools);

    // Calculate new disabled set
    const newDisabledTools: string[] = allEnabled
      ? this.result.tools.map((t) => t.name) // Disable all
      : []; // Enable all

    this.pendingToggle = true;
    if (this.toggleAllBtn) this.toggleAllBtn.disabled = true;

    // Disable all individual toggles
    for (const { checkbox } of this.toolToggles.values()) {
      checkbox.disabled = true;
    }

    // Optimistic update - update all UI at once
    this.disabledTools = new Set(newDisabledTools);
    for (const tool of this.result.tools) {
      const toggle = this.toolToggles.get(tool.name);
      const toolEl = this.toolElements.get(tool.name);
      if (!toggle || !toolEl) continue;

      const isEnabled = !this.disabledTools.has(tool.name);
      toggle.checkbox.checked = isEnabled;
      toggle.container.toggleClass('is-enabled', isEnabled);
      this.updateToolState(toolEl, isEnabled);
    }
    this.updateToggleAllButton();

    try {
      await this.onBulkToggle(newDisabledTools);
    } catch (error) {
      // Rollback all UI
      this.disabledTools = previousDisabled;
      for (const tool of this.result.tools) {
        const toggle = this.toolToggles.get(tool.name);
        const toolEl = this.toolElements.get(tool.name);
        if (!toggle || !toolEl) continue;

        const isEnabled = !this.disabledTools.has(tool.name);
        toggle.checkbox.checked = isEnabled;
        toggle.container.toggleClass('is-enabled', isEnabled);
        this.updateToolState(toolEl, isEnabled);
      }
      this.updateToggleAllButton();
      new Notice(formatToggleError(error));
    }

    // Re-enable toggles
    for (const { checkbox } of this.toolToggles.values()) {
      checkbox.disabled = false;
    }

    this.pendingToggle = false;
    if (this.toggleAllBtn) this.toggleAllBtn.disabled = false;
  }

  onClose() {
    this.contentEl.empty();
  }
}
