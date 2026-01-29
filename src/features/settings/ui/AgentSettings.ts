import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import type { AgentDefinition } from '../../../core/types';
import { t } from '../../../i18n';
import type ClaudianPlugin from '../../../main';
import { validateAgentName } from '../../../utils/agent';

const MODEL_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
] as const;

class AgentModal extends Modal {
  private plugin: ClaudianPlugin;
  private existingAgent: AgentDefinition | null;
  private onSave: (agent: AgentDefinition) => Promise<void>;

  constructor(
    app: App,
    plugin: ClaudianPlugin,
    existingAgent: AgentDefinition | null,
    onSave: (agent: AgentDefinition) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.existingAgent = existingAgent;
    this.onSave = onSave;
  }

  onOpen() {
    this.setTitle(this.existingAgent ? 'Edit Subagent' : 'Add Subagent');
    this.modalEl.addClass('claudian-agent-modal');

    const { contentEl } = this;

    let nameInput: HTMLInputElement;
    let descInput: HTMLInputElement;
    let modelValue: string = this.existingAgent?.model ?? 'inherit';
    let toolsInput: HTMLInputElement;
    let disallowedToolsInput: HTMLInputElement;
    let skillsInput: HTMLInputElement;

    new Setting(contentEl)
      .setName('Name')
      .setDesc('Lowercase letters, numbers, and hyphens only')
      .addText(text => {
        nameInput = text.inputEl;
        text.setValue(this.existingAgent?.name || '')
          .setPlaceholder('code-reviewer');
      });

    new Setting(contentEl)
      .setName('Description')
      .setDesc('Brief description of this agent')
      .addText(text => {
        descInput = text.inputEl;
        text.setValue(this.existingAgent?.description || '')
          .setPlaceholder('Reviews code for bugs and style');
      });

    const details = contentEl.createEl('details', { cls: 'claudian-agent-advanced-section' });
    details.createEl('summary', {
      text: 'Advanced options',
      cls: 'claudian-agent-advanced-summary',
    });
    if ((this.existingAgent?.model && this.existingAgent.model !== 'inherit') ||
        this.existingAgent?.tools?.length ||
        this.existingAgent?.disallowedTools?.length ||
        this.existingAgent?.skills?.length) {
      details.open = true;
    }

    new Setting(details)
      .setName('Model')
      .setDesc('Model override for this agent')
      .addDropdown(dropdown => {
        for (const opt of MODEL_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }
        dropdown
          .setValue(modelValue)
          .onChange(value => { modelValue = value; });
      });

    new Setting(details)
      .setName('Tools')
      .setDesc('Comma-separated list of allowed tools (empty = all)')
      .addText(text => {
        toolsInput = text.inputEl;
        text.setValue(this.existingAgent?.tools?.join(', ') || '');
      });

    new Setting(details)
      .setName('Disallowed tools')
      .setDesc('Comma-separated list of tools to disallow')
      .addText(text => {
        disallowedToolsInput = text.inputEl;
        text.setValue(this.existingAgent?.disallowedTools?.join(', ') || '');
      });

    new Setting(details)
      .setName('Skills')
      .setDesc('Comma-separated list of skills')
      .addText(text => {
        skillsInput = text.inputEl;
        text.setValue(this.existingAgent?.skills?.join(', ') || '');
      });

    new Setting(contentEl)
      .setName('System prompt')
      .setDesc('Instructions for the agent');

    const contentArea = contentEl.createEl('textarea', {
      cls: 'claudian-agent-content-area',
      attr: {
        rows: '10',
        placeholder: 'You are a code reviewer. Analyze the given code for...',
      },
    });
    contentArea.value = this.existingAgent?.prompt || '';

    const buttonContainer = contentEl.createDiv({ cls: 'claudian-agent-modal-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: 'Save',
      cls: 'claudian-save-btn',
    });
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const nameError = validateAgentName(name);
      if (nameError) {
        new Notice(nameError);
        return;
      }

      const description = descInput.value.trim();
      if (!description) {
        new Notice('Description is required');
        return;
      }

      const prompt = contentArea.value;
      if (!prompt.trim()) {
        new Notice('System prompt is required');
        return;
      }

      const allAgents = this.plugin.agentManager.getAvailableAgents();
      const duplicate = allAgents.find(
        a => a.id.toLowerCase() === name.toLowerCase() &&
             a.id !== this.existingAgent?.id
      );
      if (duplicate) {
        new Notice(`An agent named "${name}" already exists`);
        return;
      }

      const parseList = (input: HTMLInputElement): string[] | undefined => {
        const val = input.value.trim();
        if (!val) return undefined;
        return val.split(',').map(s => s.trim()).filter(Boolean);
      };

      const agent: AgentDefinition = {
        id: name,
        name,
        description,
        prompt,
        tools: parseList(toolsInput),
        disallowedTools: parseList(disallowedToolsInput),
        model: (modelValue as AgentDefinition['model']) || 'inherit',
        source: 'vault',
        filePath: this.existingAgent?.filePath,
        skills: parseList(skillsInput),
        permissionMode: this.existingAgent?.permissionMode,
        hooks: this.existingAgent?.hooks,
      };

      try {
        await this.onSave(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(`Failed to save subagent: ${message}`);
        return;
      }
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class AgentSettings {
  private containerEl: HTMLElement;
  private plugin: ClaudianPlugin;

  constructor(containerEl: HTMLElement, plugin: ClaudianPlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
  }

  private render(): void {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-agent-header' });
    headerEl.createSpan({ text: t('settings.subagents.name'), cls: 'claudian-agent-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-agent-header-actions' });

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Add' },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openAgentModal(null));

    const allAgents = this.plugin.agentManager.getAvailableAgents();
    const vaultAgents = allAgents.filter(a => a.source === 'vault');

    if (vaultAgents.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-agent-empty-state' });
      emptyEl.setText('No subagents configured. Click + to create one.');
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-agent-list' });

    for (const agent of vaultAgents) {
      this.renderAgentItem(listEl, agent);
    }
  }

  private renderAgentItem(listEl: HTMLElement, agent: AgentDefinition): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-agent-item' });

    const infoEl = itemEl.createDiv({ cls: 'claudian-agent-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-agent-item-header' });

    const nameEl = headerRow.createSpan({ cls: 'claudian-agent-item-name' });
    nameEl.setText(agent.name);

    if (agent.description) {
      const descEl = infoEl.createDiv({ cls: 'claudian-agent-item-desc' });
      descEl.setText(agent.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-agent-item-actions' });

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Edit' },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openAgentModal(agent));

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
      attr: { 'aria-label': 'Delete' },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      try {
        await this.deleteAgent(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(`Failed to delete subagent: ${message}`);
      }
    });
  }

  private openAgentModal(existingAgent: AgentDefinition | null): void {
    new AgentModal(
      this.plugin.app,
      this.plugin,
      existingAgent,
      (agent) => this.saveAgent(agent, existingAgent)
    ).open();
  }

  private async saveAgent(agent: AgentDefinition, existing: AgentDefinition | null): Promise<void> {
    await this.plugin.storage.agents.save(agent);

    if (existing && existing.name !== agent.name) {
      await this.plugin.storage.agents.delete(existing);
    }

    await this.plugin.agentManager.loadAgents();
    this.render();
    new Notice(`Subagent "${agent.name}" ${existing ? 'updated' : 'created'}`);
  }

  private async deleteAgent(agent: AgentDefinition): Promise<void> {
    await this.plugin.storage.agents.delete(agent);

    await this.plugin.agentManager.loadAgents();
    this.render();
    new Notice(`Subagent "${agent.name}" deleted`);
  }

}
