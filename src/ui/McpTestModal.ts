/**
 * Claudian - MCP Test Modal
 *
 * Modal for displaying MCP server connection test results.
 */

import type { App } from 'obsidian';
import { Modal, setIcon } from 'obsidian';

import type { McpTestResult, McpTool } from '../services/McpTester';

/** Modal for displaying MCP test results. */
export class McpTestModal extends Modal {
  private serverName: string;
  private result: McpTestResult | null = null;
  private loading = true;
  private contentEl_: HTMLElement | null = null;

  constructor(app: App, serverName: string) {
    super(app);
    this.serverName = serverName;
  }

  onOpen() {
    this.setTitle(`Testing: ${this.serverName}`);
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

    // Close button
    const buttonContainer = this.contentEl_.createDiv({ cls: 'claudian-mcp-test-buttons' });
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

    if (tool.description) {
      const descEl = toolEl.createDiv({ cls: 'claudian-mcp-test-tool-desc' });
      descEl.setText(tool.description);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
