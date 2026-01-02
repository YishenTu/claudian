/**
 * Claudian - Input toolbar components (model selector, thinking budget, permission toggle).
 */

import { Notice, setIcon } from 'obsidian';

import type {
  ClaudeModel,
  ClaudianMcpServer,
  PermissionMode,
  ThinkingBudget,
  UsageInfo} from '../../core/types';
import {
  DEFAULT_CLAUDE_MODELS,
  THINKING_BUDGETS
} from '../../core/types';
import type { McpService } from '../../features/mcp/McpService';
import { findConflictingPath } from '../../utils/contextPath';
import { getModelsFromEnvironment, parseEnvironmentVariables } from '../../utils/env';

/** Settings access interface for toolbar components. */
export interface ToolbarSettings {
  model: ClaudeModel;
  thinkingBudget: ThinkingBudget;
  permissionMode: PermissionMode;
  allowedContextPaths: string[];
  lastNonPlanPermissionMode?: 'yolo' | 'normal';
}

/** Callback interface for toolbar changes. */
export interface ToolbarCallbacks {
  onModelChange: (model: ClaudeModel) => Promise<void>;
  onThinkingBudgetChange: (budget: ThinkingBudget) => Promise<void>;
  onPermissionModeChange: (mode: PermissionMode) => Promise<void>;
  onContextPathsChange: (paths: string[]) => Promise<void>;
  getSettings: () => ToolbarSettings;
  getEnvironmentVariables?: () => string;
  /** Whether plan mode was initiated by the agent (EnterPlanMode tool). */
  isAgentInitiatedPlanMode?: () => boolean;
  /** Whether the user has requested plan mode (UI/prefix only). */
  isPlanModeRequested?: () => boolean;
}

/** Model selector dropdown component. */
export class ModelSelector {
  private container: HTMLElement;
  private buttonEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-model-selector' });
    this.render();
  }

  /** Returns available models (custom from env vars, or defaults). */
  private getAvailableModels() {
    let models: { value: string; label: string; description: string }[] = [];

    if (this.callbacks.getEnvironmentVariables) {
      const envVarsStr = this.callbacks.getEnvironmentVariables();
      const envVars = parseEnvironmentVariables(envVarsStr);
      const customModels = getModelsFromEnvironment(envVars);

      if (customModels.length > 0) {
        models = customModels;
      } else {
        models = [...DEFAULT_CLAUDE_MODELS];
      }
    } else {
      models = [...DEFAULT_CLAUDE_MODELS];
    }

    return models;
  }

  private render() {
    this.container.empty();

    this.buttonEl = this.container.createDiv({ cls: 'claudian-model-btn' });
    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-model-dropdown' });
    this.renderOptions();
  }

  updateDisplay() {
    if (!this.buttonEl) return;
    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();
    const modelInfo = models.find(m => m.value === currentModel);

    const displayModel = modelInfo || models[0];

    this.buttonEl.empty();

    const labelEl = this.buttonEl.createSpan({ cls: 'claudian-model-label' });
    labelEl.setText(displayModel?.label || 'Unknown');
  }

  renderOptions() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const currentModel = this.callbacks.getSettings().model;
    const models = this.getAvailableModels();

    for (const model of [...models].reverse()) {
      const option = this.dropdownEl.createDiv({ cls: 'claudian-model-option' });
      if (model.value === currentModel) {
        option.addClass('selected');
      }

      option.createSpan({ text: model.label });
      if (model.description) {
        option.setAttribute('title', model.description);
      }

      option.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onModelChange(model.value);
        this.updateDisplay();
        this.renderOptions();
      });
    }
  }
}

/** Thinking budget selector component. */
export class ThinkingBudgetSelector {
  private container: HTMLElement;
  private gearsEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-thinking-selector' });
    this.render();
  }

  private render() {
    this.container.empty();

    const labelEl = this.container.createSpan({ cls: 'claudian-thinking-label-text' });
    labelEl.setText('Thinking:');

    this.gearsEl = this.container.createDiv({ cls: 'claudian-thinking-gears' });
    this.renderGears();
  }

  private renderGears() {
    if (!this.gearsEl) return;
    this.gearsEl.empty();

    const currentBudget = this.callbacks.getSettings().thinkingBudget;
    const currentBudgetInfo = THINKING_BUDGETS.find(b => b.value === currentBudget);

    const currentEl = this.gearsEl.createDiv({ cls: 'claudian-thinking-current' });
    currentEl.setText(currentBudgetInfo?.label || 'Off');

    const optionsEl = this.gearsEl.createDiv({ cls: 'claudian-thinking-options' });

    for (const budget of [...THINKING_BUDGETS].reverse()) {
      const gearEl = optionsEl.createDiv({ cls: 'claudian-thinking-gear' });
      gearEl.setText(budget.label);
      gearEl.setAttribute('title', budget.tokens > 0 ? `${budget.tokens.toLocaleString()} tokens` : 'Disabled');

      if (budget.value === currentBudget) {
        gearEl.addClass('selected');
      }

      gearEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.callbacks.onThinkingBudgetChange(budget.value);
        this.updateDisplay();
      });
    }
  }

  updateDisplay() {
    this.renderGears();
  }
}

/** Permission mode toggle (YOLO/Safe/Plan). */
export class PermissionToggle {
  private container: HTMLElement;
  private toggleEl: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;
  private onPlanModeToggle: ((active: boolean) => void) | null = null;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-permission-toggle' });
    this.render();
  }

  private render() {
    this.container.empty();

    this.labelEl = this.container.createSpan({ cls: 'claudian-permission-label' });
    this.toggleEl = this.container.createDiv({ cls: 'claudian-toggle-switch' });

    this.updateDisplay();

    this.toggleEl.addEventListener('click', () => this.toggle());
    // Container click while in plan mode (do not allow exit)
    this.container.addEventListener('click', (e) => {
      if (this.isPlanModeLocked() && e.target !== this.toggleEl) {
        new Notice('Plan mode is active until the plan is approved.');
      }
    });
  }

  /** Set callback for plan mode toggle. */
  setOnPlanModeToggle(callback: (active: boolean) => void) {
    this.onPlanModeToggle = callback;
  }

  /** Set plan mode active state. */
  setPlanModeActive(_active: boolean) {
    this.updateDisplay();
  }

  /** Check if plan mode is active. */
  isPlanModeActive(): boolean {
    return this.isPlanModeLocked() || this.isPlanModeRequested();
  }

  private isPlanModeLocked(): boolean {
    return this.callbacks.getSettings().permissionMode === 'plan';
  }

  private isPlanModeRequested(): boolean {
    return this.callbacks.isPlanModeRequested?.() ?? false;
  }

  updateDisplay() {
    if (!this.toggleEl || !this.labelEl) return;

    // Plan mode takes precedence
    if (this.isPlanModeActive()) {
      this.toggleEl.removeClass('active');
      this.container.addClass('plan-mode');
      // Show pause icon (two vertical bars) + "Plan Mode"
      this.labelEl.empty();
      const iconEl = this.labelEl.createSpan({ cls: 'claudian-plan-mode-icon' });
      iconEl.textContent = '▎▎';
      iconEl.style.fontSize = '0.8em';
      iconEl.style.letterSpacing = '-4px';
      this.labelEl.createSpan({ text: 'Plan Mode' });
      return;
    }

    this.container.removeClass('plan-mode');
    const isYolo = this.callbacks.getSettings().permissionMode === 'yolo';

    if (isYolo) {
      this.toggleEl.addClass('active');
    } else {
      this.toggleEl.removeClass('active');
    }

    this.labelEl.setText(isYolo ? 'YOLO' : 'Safe');
  }

  private async toggle() {
    // If in plan mode, do not allow exit
    if (this.isPlanModeLocked()) {
      new Notice('Plan mode is active until the plan is approved.');
      return;
    }

    const current = this.callbacks.getSettings().permissionMode;
    const newMode: PermissionMode = current === 'yolo' ? 'normal' : 'yolo';
    await this.callbacks.onPermissionModeChange(newMode);
    this.updateDisplay();
  }

  /** Toggle plan mode on/off. */
  async togglePlanMode() {
    if (this.isPlanModeLocked()) {
      new Notice('Plan mode is active until the plan is approved.');
      return;
    }
    const nextRequested = !this.isPlanModeRequested();
    this.onPlanModeToggle?.(nextRequested);
    this.updateDisplay();
  }
}

/** Context path selector component (folder icon). */
export class ContextPathSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private callbacks: ToolbarCallbacks;

  constructor(parentEl: HTMLElement, callbacks: ToolbarCallbacks) {
    this.callbacks = callbacks;
    this.container = parentEl.createDiv({ cls: 'claudian-context-path-selector' });
    this.render();
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'claudian-context-path-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'claudian-context-path-icon' });
    setIcon(this.iconEl, 'folder');

    this.badgeEl = iconWrapper.createDiv({ cls: 'claudian-context-path-badge' });

    this.updateDisplay();

    // Click to open native folder picker
    iconWrapper.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openFolderPicker();
    });

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-context-path-dropdown' });
    this.renderDropdown();
  }

  private async openFolderPicker() {
    try {
      // Access Electron's dialog through remote
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { remote } = require('electron');
      const result = await remote.dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Context Path (Read-Only)',
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        const paths = this.callbacks.getSettings().allowedContextPaths;

        // Check for duplicate
        if (paths.includes(selectedPath)) {
          return;
        }

        // Check for nested/overlapping paths
        const conflict = findConflictingPath(selectedPath, paths);
        if (conflict) {
          // Show warning notice
          this.showConflictNotice(selectedPath, conflict);
          return;
        }

        const newPaths = [...paths, selectedPath];
        await this.callbacks.onContextPathsChange(newPaths);
        this.updateDisplay();
        this.renderDropdown();
      }
    } catch (err) {
      console.error('Failed to open folder picker:', err);
    }
  }

  /** Shows a notice when a conflicting path is detected. */
  private showConflictNotice(newPath: string, conflict: { path: string; type: 'parent' | 'child' }) {
    const shortNew = this.shortenPath(newPath);
    const shortExisting = this.shortenPath(conflict.path);

    let message: string;
    if (conflict.type === 'parent') {
      message = `Cannot add "${shortNew}" - it's inside existing path "${shortExisting}"`;
    } else {
      message = `Cannot add "${shortNew}" - it contains existing path "${shortExisting}"`;
    }

    new Notice(message, 5000);
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;
    this.dropdownEl.empty();

    const paths = this.callbacks.getSettings().allowedContextPaths;

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'claudian-context-path-header' });
    headerEl.setText('Context Paths (Read-Only)');

    // Path list
    const listEl = this.dropdownEl.createDiv({ cls: 'claudian-context-path-list' });

    if (paths.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'claudian-context-path-empty' });
      emptyEl.setText('Click folder icon to add');
    } else {
      for (const pathStr of paths) {
        const itemEl = listEl.createDiv({ cls: 'claudian-context-path-item' });

        const pathTextEl = itemEl.createSpan({ cls: 'claudian-context-path-text' });
        // Show shortened path for display
        const displayPath = this.shortenPath(pathStr);
        pathTextEl.setText(displayPath);
        pathTextEl.setAttribute('title', pathStr);

        const removeBtn = itemEl.createSpan({ cls: 'claudian-context-path-remove' });
        setIcon(removeBtn, 'x');
        removeBtn.setAttribute('title', 'Remove path');
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const newPaths = paths.filter(p => p !== pathStr);
          await this.callbacks.onContextPathsChange(newPaths);
          this.updateDisplay();
          this.renderDropdown();
        });
      }
    }
  }

  /** Shorten path for display (replace home dir with ~) */
  private shortenPath(fullPath: string): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = require('os');
      const homeDir = os.homedir();
      const normalize = (value: string) => value.replace(/\\/g, '/');
      const normalizedFull = normalize(fullPath);
      const normalizedHome = normalize(homeDir);
      const compareFull = process.platform === 'win32'
        ? normalizedFull.toLowerCase()
        : normalizedFull;
      const compareHome = process.platform === 'win32'
        ? normalizedHome.toLowerCase()
        : normalizedHome;
      if (compareFull.startsWith(compareHome)) {
        return '~' + fullPath.slice(homeDir.length);
      }
    } catch {
      // Fall back to full path
    }
    return fullPath;
  }

  updateDisplay() {
    if (!this.iconEl || !this.badgeEl) return;

    const paths = this.callbacks.getSettings().allowedContextPaths;
    const count = paths.length;

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} context path${count > 1 ? 's' : ''} (click to add more)`);

      // Show badge only when more than 1 path
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'Add context paths (click)');
      this.badgeEl.removeClass('visible');
    }
  }
}

/** MCP server selector component (plug icon). */
export class McpServerSelector {
  private container: HTMLElement;
  private iconEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dropdownEl: HTMLElement | null = null;
  private mcpService: McpService | null = null;
  private enabledServers: Set<string> = new Set();
  private onChangeCallback: ((enabled: Set<string>) => void) | null = null;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-mcp-selector' });
    this.render();
  }

  /** Set the MCP service for fetching server list. */
  setMcpService(service: McpService | null): void {
    this.mcpService = service;
    this.pruneEnabledServers();
    this.updateDisplay();
    this.renderDropdown();
  }

  /** Set callback for when enabled servers change. */
  setOnChange(callback: (enabled: Set<string>) => void): void {
    this.onChangeCallback = callback;
  }

  /** Get currently enabled servers (via click or @-mention). */
  getEnabledServers(): Set<string> {
    return new Set(this.enabledServers);
  }

  /** Add servers from @-mentions. */
  addMentionedServers(names: Set<string>): void {
    let changed = false;
    for (const name of names) {
      if (!this.enabledServers.has(name)) {
        this.enabledServers.add(name);
        changed = true;
      }
    }
    if (changed) {
      this.updateDisplay();
      this.renderDropdown();
    }
  }

  /** Clear enabled servers (call on new conversation). */
  clearEnabled(): void {
    this.enabledServers.clear();
    this.updateDisplay();
    this.renderDropdown();
  }

  private pruneEnabledServers(): void {
    if (!this.mcpService) return;
    const activeNames = new Set(this.mcpService.getServers().filter((s) => s.enabled).map((s) => s.name));
    let changed = false;
    for (const name of this.enabledServers) {
      if (!activeNames.has(name)) {
        this.enabledServers.delete(name);
        changed = true;
      }
    }
    if (changed) {
      this.onChangeCallback?.(this.enabledServers);
    }
  }

  private render() {
    this.container.empty();

    const iconWrapper = this.container.createDiv({ cls: 'claudian-mcp-selector-icon-wrapper' });

    this.iconEl = iconWrapper.createDiv({ cls: 'claudian-mcp-selector-icon' });
    setIcon(this.iconEl, 'plug');

    this.badgeEl = iconWrapper.createDiv({ cls: 'claudian-mcp-selector-badge' });

    this.updateDisplay();

    this.dropdownEl = this.container.createDiv({ cls: 'claudian-mcp-selector-dropdown' });
    this.renderDropdown();

    // Re-render dropdown content on hover (CSS handles visibility)
    this.container.addEventListener('mouseenter', () => {
      this.renderDropdown();
    });
  }

  private renderDropdown() {
    if (!this.dropdownEl) return;
    this.pruneEnabledServers();
    this.dropdownEl.empty();

    // Header
    const headerEl = this.dropdownEl.createDiv({ cls: 'claudian-mcp-selector-header' });
    headerEl.setText('MCP Servers');

    // Server list
    const listEl = this.dropdownEl.createDiv({ cls: 'claudian-mcp-selector-list' });

    const allServers = this.mcpService?.getServers() || [];
    const servers = allServers.filter(s => s.enabled);

    if (servers.length === 0) {
      const emptyEl = listEl.createDiv({ cls: 'claudian-mcp-selector-empty' });
      emptyEl.setText(allServers.length === 0 ? 'No MCP servers configured' : 'All MCP servers disabled');
      return;
    }

    for (const server of servers) {
      this.renderServerItem(listEl, server);
    }
  }

  private renderServerItem(listEl: HTMLElement, server: ClaudianMcpServer) {
    const itemEl = listEl.createDiv({ cls: 'claudian-mcp-selector-item' });
    itemEl.dataset.serverName = server.name;

    const isEnabled = this.enabledServers.has(server.name);
    if (isEnabled) {
      itemEl.addClass('enabled');
    }

    // Checkbox
    const checkEl = itemEl.createDiv({ cls: 'claudian-mcp-selector-check' });
    if (isEnabled) {
      setIcon(checkEl, 'check');
    }

    // Info
    const infoEl = itemEl.createDiv({ cls: 'claudian-mcp-selector-item-info' });

    const nameEl = infoEl.createSpan({ cls: 'claudian-mcp-selector-item-name' });
    nameEl.setText(server.name);

    // Badges
    if (server.contextSaving) {
      const csEl = infoEl.createSpan({ cls: 'claudian-mcp-selector-cs-badge' });
      csEl.setText('@');
      csEl.setAttribute('title', 'Context-saving: can also enable via @' + server.name);
    }

    // Click to toggle
    itemEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleServer(server.name, itemEl);
    });
  }

  private toggleServer(name: string, itemEl?: HTMLElement) {
    if (this.enabledServers.has(name)) {
      this.enabledServers.delete(name);
    } else {
      this.enabledServers.add(name);
    }

    // Update item in-place if provided
    if (itemEl) {
      const isEnabled = this.enabledServers.has(name);
      const checkEl = itemEl.querySelector('.claudian-mcp-selector-check');

      if (isEnabled) {
        itemEl.addClass('enabled');
        if (checkEl) setIcon(checkEl as HTMLElement, 'check');
      } else {
        itemEl.removeClass('enabled');
        if (checkEl) checkEl.empty();
      }
    }

    this.updateDisplay();
    this.onChangeCallback?.(this.enabledServers);
  }

  updateDisplay() {
    this.pruneEnabledServers();
    if (!this.iconEl || !this.badgeEl) return;

    const count = this.enabledServers.size;
    const hasServers = (this.mcpService?.getServers().length || 0) > 0;

    // Show/hide container based on whether there are servers
    if (!hasServers) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = '';

    if (count > 0) {
      this.iconEl.addClass('active');
      this.iconEl.setAttribute('title', `${count} MCP server${count > 1 ? 's' : ''} enabled (click to manage)`);

      // Show badge only when more than 1
      if (count > 1) {
        this.badgeEl.setText(String(count));
        this.badgeEl.addClass('visible');
      } else {
        this.badgeEl.removeClass('visible');
      }
    } else {
      this.iconEl.removeClass('active');
      this.iconEl.setAttribute('title', 'MCP servers (click to enable)');
      this.badgeEl.removeClass('visible');
    }
  }
}

/** Context usage meter component (240° arc gauge). */
export class ContextUsageMeter {
  private container: HTMLElement;
  private fillPath: SVGPathElement | null = null;
  private percentEl: HTMLElement | null = null;
  private circumference: number = 0;

  constructor(parentEl: HTMLElement) {
    this.container = parentEl.createDiv({ cls: 'claudian-context-meter' });
    this.render();
    // Initially hidden
    this.container.style.display = 'none';
  }

  private render() {
    const size = 16;
    const strokeWidth = 2;
    const radius = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;

    // 240° arc: from 150° to 390° (upper-left through bottom to upper-right)
    const startAngle = 150;
    const endAngle = 390;
    const arcDegrees = endAngle - startAngle;
    const arcRadians = (arcDegrees * Math.PI) / 180;
    this.circumference = radius * arcRadians;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + radius * Math.cos(startRad);
    const y1 = cy + radius * Math.sin(startRad);
    const x2 = cx + radius * Math.cos(endRad);
    const y2 = cy + radius * Math.sin(endRad);

    const gaugeEl = this.container.createDiv({ cls: 'claudian-context-meter-gauge' });
    gaugeEl.innerHTML = `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <path class="claudian-meter-bg"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"/>
        <path class="claudian-meter-fill"
          d="M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2}"
          fill="none" stroke-width="${strokeWidth}" stroke-linecap="round"
          stroke-dasharray="${this.circumference}" stroke-dashoffset="${this.circumference}"/>
      </svg>
    `;
    this.fillPath = gaugeEl.querySelector('.claudian-meter-fill');

    this.percentEl = this.container.createSpan({ cls: 'claudian-context-meter-percent' });
  }

  update(usage: UsageInfo | null): void {
    if (!usage) {
      this.container.style.display = 'none';
      return;
    }
    this.container.style.display = 'flex';
    const fillLength = (usage.percentage / 100) * this.circumference;
    if (this.fillPath) {
      this.fillPath.style.strokeDashoffset = String(this.circumference - fillLength);
    }

    if (this.percentEl) {
      this.percentEl.setText(`${usage.percentage}%`);
    }

    // Toggle warning class for > 80%
    if (usage.percentage > 80) {
      this.container.addClass('warning');
    } else {
      this.container.removeClass('warning');
    }

    // Set tooltip with detailed usage
    const tooltip = `${this.formatTokens(usage.contextTokens)} / ${this.formatTokens(usage.contextWindow)}`;
    this.container.setAttribute('data-tooltip', tooltip);
  }

  /** Format token count (e.g., 45000 -> "45k", 200000 -> "200k") */
  private formatTokens(tokens: number): string {
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}

/** Factory function to create all toolbar components. */
export function createInputToolbar(
  parentEl: HTMLElement,
  callbacks: ToolbarCallbacks
): {
  modelSelector: ModelSelector;
  thinkingBudgetSelector: ThinkingBudgetSelector;
  contextUsageMeter: ContextUsageMeter;
  contextPathSelector: ContextPathSelector;
  mcpServerSelector: McpServerSelector;
  permissionToggle: PermissionToggle;
} {
  const modelSelector = new ModelSelector(parentEl, callbacks);
  const thinkingBudgetSelector = new ThinkingBudgetSelector(parentEl, callbacks);
  const contextUsageMeter = new ContextUsageMeter(parentEl);
  const contextPathSelector = new ContextPathSelector(parentEl, callbacks);
  const mcpServerSelector = new McpServerSelector(parentEl);
  const permissionToggle = new PermissionToggle(parentEl, callbacks);

  return { modelSelector, thinkingBudgetSelector, contextUsageMeter, contextPathSelector, mcpServerSelector, permissionToggle };
}
