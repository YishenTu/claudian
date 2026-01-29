import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import type { AgentDefinition } from '../../../core/types';
import { t } from '../../../i18n';
import type ClaudianPlugin from '../../../main';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
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
    this.setTitle(
      this.existingAgent
        ? t('settings.subagents.modal.titleEdit')
        : t('settings.subagents.modal.titleAdd')
    );
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    let nameInput: HTMLInputElement;
    let descInput: HTMLInputElement;
    let modelValue: string = this.existingAgent?.model ?? 'inherit';
    let toolsInput: HTMLInputElement;
    let disallowedToolsInput: HTMLInputElement;
    let skillsInput: HTMLInputElement;

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.name'))
      .setDesc(t('settings.subagents.modal.nameDesc'))
      .addText(text => {
        nameInput = text.inputEl;
        text.setValue(this.existingAgent?.name || '')
          .setPlaceholder(t('settings.subagents.modal.namePlaceholder'));
      });

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.description'))
      .setDesc(t('settings.subagents.modal.descriptionDesc'))
      .addText(text => {
        descInput = text.inputEl;
        text.setValue(this.existingAgent?.description || '')
          .setPlaceholder(t('settings.subagents.modal.descriptionPlaceholder'));
      });

    const details = contentEl.createEl('details', { cls: 'claudian-sp-advanced-section' });
    details.createEl('summary', {
      text: t('settings.subagents.modal.advancedOptions'),
      cls: 'claudian-sp-advanced-summary',
    });
    if ((this.existingAgent?.model && this.existingAgent.model !== 'inherit') ||
        this.existingAgent?.tools?.length ||
        this.existingAgent?.disallowedTools?.length ||
        this.existingAgent?.skills?.length) {
      details.open = true;
    }

    new Setting(details)
      .setName(t('settings.subagents.modal.model'))
      .setDesc(t('settings.subagents.modal.modelDesc'))
      .addDropdown(dropdown => {
        for (const opt of MODEL_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }
        dropdown
          .setValue(modelValue)
          .onChange(value => { modelValue = value; });
      });

    new Setting(details)
      .setName(t('settings.subagents.modal.tools'))
      .setDesc(t('settings.subagents.modal.toolsDesc'))
      .addText(text => {
        toolsInput = text.inputEl;
        text.setValue(this.existingAgent?.tools?.join(', ') || '');
      });

    new Setting(details)
      .setName(t('settings.subagents.modal.disallowedTools'))
      .setDesc(t('settings.subagents.modal.disallowedToolsDesc'))
      .addText(text => {
        disallowedToolsInput = text.inputEl;
        text.setValue(this.existingAgent?.disallowedTools?.join(', ') || '');
      });

    new Setting(details)
      .setName(t('settings.subagents.modal.skills'))
      .setDesc(t('settings.subagents.modal.skillsDesc'))
      .addText(text => {
        skillsInput = text.inputEl;
        text.setValue(this.existingAgent?.skills?.join(', ') || '');
      });

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.prompt'))
      .setDesc(t('settings.subagents.modal.promptDesc'));

    const contentArea = contentEl.createEl('textarea', {
      cls: 'claudian-sp-content-area',
      attr: {
        rows: '10',
        placeholder: t('settings.subagents.modal.promptPlaceholder'),
      },
    });
    contentArea.value = this.existingAgent?.prompt || '';

    const buttonContainer = contentEl.createDiv({ cls: 'claudian-sp-modal-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: t('common.cancel'),
      cls: 'claudian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: t('common.save'),
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
        new Notice(t('settings.subagents.descriptionRequired'));
        return;
      }

      const prompt = contentArea.value;
      if (!prompt.trim()) {
        new Notice(t('settings.subagents.promptRequired'));
        return;
      }

      const allAgents = this.plugin.agentManager.getAvailableAgents();
      const duplicate = allAgents.find(
        a => a.id.toLowerCase() === name.toLowerCase() &&
             a.id !== this.existingAgent?.id
      );
      if (duplicate) {
        new Notice(t('settings.subagents.duplicateName', { name }));
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
        filePath: (this.existingAgent && this.existingAgent.name === name)
          ? this.existingAgent.filePath
          : undefined,
        skills: parseList(skillsInput),
        permissionMode: this.existingAgent?.permissionMode,
        hooks: this.existingAgent?.hooks,
        extraFrontmatter: this.existingAgent?.extraFrontmatter,
      };

      try {
        await this.onSave(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(t('settings.subagents.saveFailed', { message }));
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

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-sp-header' });
    headerEl.createSpan({ text: t('settings.subagents.name'), cls: 'claudian-sp-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-sp-header-actions' });

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.add') },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openAgentModal(null));

    const allAgents = this.plugin.agentManager.getAvailableAgents();
    const vaultAgents = allAgents.filter(a => a.source === 'vault');

    if (vaultAgents.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText(t('settings.subagents.noAgents'));
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });

    for (const agent of vaultAgents) {
      this.renderAgentItem(listEl, agent);
    }
  }

  private renderAgentItem(listEl: HTMLElement, agent: AgentDefinition): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });

    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });

    const nameEl = headerRow.createSpan({ cls: 'claudian-sp-item-name' });
    nameEl.setText(agent.name);

    if (agent.description) {
      const descEl = infoEl.createDiv({ cls: 'claudian-sp-item-desc' });
      descEl.setText(agent.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-sp-item-actions' });

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.edit') },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openAgentModal(agent));

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
      attr: { 'aria-label': t('common.delete') },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      const confirmed = await confirmDelete(
        this.plugin.app,
        t('settings.subagents.deleteConfirm', { name: agent.name })
      );
      if (!confirmed) return;
      try {
        await this.deleteAgent(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(t('settings.subagents.deleteFailed', { message }));
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
      try {
        await this.plugin.storage.agents.delete(existing);
      } catch {
        new Notice(t('settings.subagents.renameCleanupFailed', { name: existing.name }));
      }
    }

    try {
      await this.plugin.agentManager.loadAgents();
    } catch {
      // Non-critical: agent list will refresh on next settings open
    }
    this.render();
    const action = existing ? 'updated' : 'created';
    new Notice(t('settings.subagents.saved', { name: agent.name, action }));
  }

  private async deleteAgent(agent: AgentDefinition): Promise<void> {
    await this.plugin.storage.agents.delete(agent);

    try {
      await this.plugin.agentManager.loadAgents();
    } catch {
      // Non-critical: agent list will refresh on next settings open
    }
    this.render();
    new Notice(t('settings.subagents.deleted', { name: agent.name }));
  }

}
