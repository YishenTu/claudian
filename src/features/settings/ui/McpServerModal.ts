/**
 * Claudian - MCP Server Modal
 *
 * Modal for adding and editing MCP server configurations.
 * Supports stdio, sse, and http server types.
 */

import type { App } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

import type {
  ClaudianMcpServer,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerType,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../../core/types';
import { DEFAULT_MCP_SERVER, getMcpServerType } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { parseCommand } from '../../../utils/mcp';

/** Modal for creating/editing MCP server configurations. */
export class McpServerModal extends Modal {
  private plugin: ClaudianPlugin;
  private existingServer: ClaudianMcpServer | null;
  private onSave: (server: ClaudianMcpServer) => void;

  // Form state
  private serverName = '';
  private serverType: McpServerType = 'stdio';
  private enabled = DEFAULT_MCP_SERVER.enabled;
  private contextSaving = DEFAULT_MCP_SERVER.contextSaving;

  // Stdio fields
  private command = '';  // Full command including args
  private env = '';

  // SSE/HTTP fields
  private url = '';
  private headers = '';

  // DOM references
  private typeFieldsEl: HTMLElement | null = null;
  private nameInputEl: HTMLInputElement | null = null;

  constructor(
    app: App,
    plugin: ClaudianPlugin,
    existingServer: ClaudianMcpServer | null,
    onSave: (server: ClaudianMcpServer) => void,
    initialType?: McpServerType,
    prefillConfig?: { name: string; config: McpServerConfig }
  ) {
    super(app);
    this.plugin = plugin;
    this.existingServer = existingServer;
    this.onSave = onSave;

    // Initialize from existing server if editing
    if (existingServer) {
      this.serverName = existingServer.name;
      this.serverType = getMcpServerType(existingServer.config);
      this.enabled = existingServer.enabled;
      this.contextSaving = existingServer.contextSaving;
      this.initFromConfig(existingServer.config);
    } else if (prefillConfig) {
      // Pre-fill from clipboard import
      this.serverName = prefillConfig.name;
      this.serverType = getMcpServerType(prefillConfig.config);
      this.initFromConfig(prefillConfig.config);
    } else if (initialType) {
      // Set initial type from dropdown selection
      this.serverType = initialType;
    }
  }

  /** Initialize form fields from a config object. */
  private initFromConfig(config: McpServerConfig) {
    const type = getMcpServerType(config);
    if (type === 'stdio') {
      const stdioConfig = config as McpStdioServerConfig;
      if (stdioConfig.args && stdioConfig.args.length > 0) {
        this.command = stdioConfig.command + ' ' + stdioConfig.args.join(' ');
      } else {
        this.command = stdioConfig.command;
      }
      this.env = this.envRecordToString(stdioConfig.env);
    } else {
      const urlConfig = config as McpSSEServerConfig | McpHttpServerConfig;
      this.url = urlConfig.url;
      this.headers = this.envRecordToString(urlConfig.headers);
    }
  }

  onOpen() {
    this.setTitle(this.existingServer ? 'Edit MCP Server' : 'Add MCP Server');
    this.modalEl.addClass('claudian-mcp-modal');

    const { contentEl } = this;

    // Server name
    new Setting(contentEl)
      .setName('Server name')
      .setDesc('Unique identifier for this server')
      .addText((text) => {
        this.nameInputEl = text.inputEl;
        text.setValue(this.serverName);
        text.setPlaceholder('my-mcp-server');
        text.onChange((value) => {
          this.serverName = value;
        });
        text.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));
      });

    // Server type
    new Setting(contentEl)
      .setName('Type')
      .setDesc('Server connection type')
      .addDropdown((dropdown) => {
        dropdown.addOption('stdio', 'stdio (local command)');
        dropdown.addOption('sse', 'sse (Server-Sent Events)');
        dropdown.addOption('http', 'http (HTTP endpoint)');
        dropdown.setValue(this.serverType);
        dropdown.onChange((value) => {
          this.serverType = value as McpServerType;
          this.renderTypeFields();
        });
      });

    // Type-specific fields container
    this.typeFieldsEl = contentEl.createDiv({ cls: 'claudian-mcp-type-fields' });
    this.renderTypeFields();

    // Enabled toggle
    new Setting(contentEl)
      .setName('Enabled')
      .setDesc('Whether this server is active')
      .addToggle((toggle) => {
        toggle.setValue(this.enabled);
        toggle.onChange((value) => {
          this.enabled = value;
        });
      });

    // Context-saving toggle
    new Setting(contentEl)
      .setName('Context-saving mode')
      .setDesc('Hide tools from agent unless @-mentioned (saves context window)')
      .addToggle((toggle) => {
        toggle.setValue(this.contextSaving);
        toggle.onChange((value) => {
          this.contextSaving = value;
        });
      });

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: 'claudian-mcp-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: this.existingServer ? 'Update' : 'Add',
      cls: 'claudian-save-btn mod-cta',
    });
    saveBtn.addEventListener('click', () => this.save());
  }

  private renderTypeFields() {
    if (!this.typeFieldsEl) return;
    this.typeFieldsEl.empty();

    if (this.serverType === 'stdio') {
      this.renderStdioFields();
    } else {
      this.renderUrlFields();
    }
  }

  private renderStdioFields() {
    if (!this.typeFieldsEl) return;

    // Command (single field for full command with args)
    const cmdSetting = new Setting(this.typeFieldsEl)
      .setName('Command')
      .setDesc('Full command with arguments');
    cmdSetting.settingEl.addClass('claudian-mcp-cmd-setting');

    const cmdTextarea = cmdSetting.controlEl.createEl('textarea', {
      cls: 'claudian-mcp-cmd-textarea',
    });
    cmdTextarea.value = this.command;
    cmdTextarea.placeholder = 'docker exec -i mcp-server python -m src.server';
    cmdTextarea.rows = 2;
    cmdTextarea.addEventListener('input', () => {
      this.command = cmdTextarea.value;
    });

    // Environment variables (collapsible)
    const envSetting = new Setting(this.typeFieldsEl)
      .setName('Environment variables')
      .setDesc('KEY=VALUE per line (optional)');
    envSetting.settingEl.addClass('claudian-mcp-env-setting');

    const envTextarea = envSetting.controlEl.createEl('textarea', {
      cls: 'claudian-mcp-env-textarea',
    });
    envTextarea.value = this.env;
    envTextarea.placeholder = 'API_KEY=your-key';
    envTextarea.rows = 2;
    envTextarea.addEventListener('input', () => {
      this.env = envTextarea.value;
    });
  }

  private renderUrlFields() {
    if (!this.typeFieldsEl) return;

    // URL
    new Setting(this.typeFieldsEl)
      .setName('URL')
      .setDesc(this.serverType === 'sse' ? 'SSE endpoint URL' : 'HTTP endpoint URL')
      .addText((text) => {
        text.setValue(this.url);
        text.setPlaceholder('http://localhost:3000/sse');
        text.onChange((value) => {
          this.url = value;
        });
        text.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));
      });

    // Headers
    const headersSetting = new Setting(this.typeFieldsEl)
      .setName('Headers')
      .setDesc('HTTP headers (KEY=VALUE per line)');
    headersSetting.settingEl.addClass('claudian-mcp-env-setting');

    const headersTextarea = headersSetting.controlEl.createEl('textarea', {
      cls: 'claudian-mcp-env-textarea',
    });
    headersTextarea.value = this.headers;
    headersTextarea.placeholder = 'Authorization=Bearer token\nContent-Type=application/json';
    headersTextarea.rows = 3;
    headersTextarea.addEventListener('input', () => {
      this.headers = headersTextarea.value;
    });
  }

  private handleKeyDown(e: KeyboardEvent) {
    // Check !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.save();
    } else if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      this.close();
    }
  }

  private save() {
    // Validate
    const name = this.serverName.trim();
    if (!name) {
      new Notice('Please enter a server name');
      this.nameInputEl?.focus();
      return;
    }

    // Validate name format (alphanumeric, dots, hyphens, underscores)
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      new Notice('Server name can only contain letters, numbers, dots, hyphens, and underscores');
      this.nameInputEl?.focus();
      return;
    }

    let config: McpServerConfig;

    if (this.serverType === 'stdio') {
      const fullCommand = this.command.trim();
      if (!fullCommand) {
        new Notice('Please enter a command');
        return;
      }

      // Parse command string: first part is command, rest are args
      const { cmd, args } = parseCommand(fullCommand);
      const stdioConfig: McpStdioServerConfig = { command: cmd };

      if (args.length > 0) {
        stdioConfig.args = args;
      }

      const env = this.parseEnvString(this.env);
      if (Object.keys(env).length > 0) {
        stdioConfig.env = env;
      }

      config = stdioConfig;
    } else {
      const url = this.url.trim();
      if (!url) {
        new Notice('Please enter a URL');
        return;
      }

      if (this.serverType === 'sse') {
        const sseConfig: McpSSEServerConfig = { type: 'sse', url };
        const headers = this.parseEnvString(this.headers);
        if (Object.keys(headers).length > 0) {
          sseConfig.headers = headers;
        }
        config = sseConfig;
      } else {
        const httpConfig: McpHttpServerConfig = { type: 'http', url };
        const headers = this.parseEnvString(this.headers);
        if (Object.keys(headers).length > 0) {
          httpConfig.headers = headers;
        }
        config = httpConfig;
      }
    }

    const server: ClaudianMcpServer = {
      name,
      config,
      enabled: this.enabled,
      contextSaving: this.contextSaving,
      disabledTools: this.existingServer?.disabledTools,
    };

    this.onSave(server);
    this.close();
  }

  private parseEnvString(envStr: string): Record<string, string> {
    const result: Record<string, string> = {};
    if (!envStr.trim()) return result;

    for (const line of envStr.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();

      if (key) {
        result[key] = value;
      }
    }

    return result;
  }

  private envRecordToString(env: Record<string, string> | undefined): string {
    if (!env) return '';
    return Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  }

  onClose() {
    this.contentEl.empty();
  }
}
