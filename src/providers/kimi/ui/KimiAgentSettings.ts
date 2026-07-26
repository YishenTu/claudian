import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import { t } from '../../../i18n/i18n';
import type { TranslationKey } from '../../../i18n/types';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import {
  KIMI_BRAND_AGENTS_PATH,
  type KimiAgentDefinition,
  type KimiAgentStorage,
  validateKimiAgentName,
} from '../agents/KimiAgentStorage';

// kimi agent files only accept the symbolic primary/secondary model preference;
// omitting the field lets the CLI decide (secondary when configured). There is
// no per-agent concrete model or effort field — see kimi-code agentFileCatalog.
const MODEL_CHOICE_OPTIONS = ['primary', 'secondary', 'cli-default'] as const;
type KimiModelChoice = (typeof MODEL_CHOICE_OPTIONS)[number];

const MODEL_CHOICE_LABEL_KEYS: Record<KimiModelChoice, TranslationKey> = {
  'cli-default': 'settings.kimi.subagents.modelCliDefault',
  primary: 'settings.kimi.subagents.modelPrimary',
  secondary: 'settings.kimi.subagents.modelSecondary',
};

export function resolveKimiModelPreference(
  value: string,
): KimiAgentDefinition['modelPreference'] {
  return value === 'primary' || value === 'secondary' ? value : undefined;
}

// Tool lists are not editable in the modal for now, so an edit must carry the
// file's existing tools/disallowedTools through unchanged.
export function buildKimiAgentSavePayload(params: {
  description: string;
  existing: KimiAgentDefinition | null;
  modelChoice: string;
  name: string;
  prompt: string;
}): KimiAgentDefinition {
  const { description, existing, modelChoice, name, prompt } = params;
  return {
    description,
    disallowedTools: existing?.disallowedTools,
    extraFrontmatter: existing?.extraFrontmatter,
    filePath: existing?.filePath ?? '',
    modelPreference: resolveKimiModelPreference(modelChoice),
    name,
    prompt,
    tools: existing?.tools,
  };
}

export function findKimiAgentNameConflict(
  agents: KimiAgentDefinition[],
  name: string,
  currentFilePath?: string,
): KimiAgentDefinition | null {
  const normalizedName = name.toLowerCase();
  return agents.find(
    (agent) => agent.name.toLowerCase() === normalizedName
      && agent.filePath !== currentFilePath,
  ) ?? null;
}

class KimiAgentModal extends Modal {
  constructor(
    app: App,
    private existing: KimiAgentDefinition | null,
    private allAgents: KimiAgentDefinition[],
    private onSave: (agent: KimiAgentDefinition) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    this.setTitle(this.existing
      ? t('settings.subagents.modal.titleEdit')
      : t('settings.subagents.modal.titleAdd'));
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    let nameInput!: HTMLInputElement;
    let descriptionInput!: HTMLInputElement;
    // New agents default to primary (inherit the chat model); existing files
    // without a preference show the honest CLI-default state.
    let modelValue: KimiModelChoice = this.existing
      ? this.existing.modelPreference ?? 'cli-default'
      : 'primary';

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.name'))
      .setDesc(t('settings.subagents.modal.nameDesc'))
      .addText((text) => {
        nameInput = text.inputEl;
        text.setValue(this.existing?.name ?? '')
          .setPlaceholder(t('settings.subagents.modal.namePlaceholder'));
      });

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.description'))
      .setDesc(t('settings.subagents.modal.descriptionDesc'))
      .addText((text) => {
        descriptionInput = text.inputEl;
        text.setValue(this.existing?.description ?? '')
          .setPlaceholder(t('settings.subagents.modal.descriptionPlaceholder'));
      });

    const details = contentEl.createEl('details', { cls: 'claudian-sp-advanced-section' });
    details.createEl('summary', {
      text: t('settings.subagents.modal.advancedOptions'),
      cls: 'claudian-sp-advanced-summary',
    });
    if (this.existing?.modelPreference) {
      details.open = true;
    }

    new Setting(details)
      .setName(t('settings.subagents.modal.model'))
      .setDesc(t('settings.kimi.subagents.modelDesc'))
      .addDropdown((dropdown) => {
        for (const option of MODEL_CHOICE_OPTIONS) {
          dropdown.addOption(option, t(MODEL_CHOICE_LABEL_KEYS[option]));
        }
        dropdown
          .setValue(modelValue)
          .onChange((value) => {
            modelValue = value as KimiModelChoice;
          });
      });

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.prompt'))
      .setDesc(t('settings.subagents.modal.promptDesc'));

    const promptArea = contentEl.createEl('textarea', {
      cls: 'claudian-sp-content-area',
      attr: {
        rows: '10',
        placeholder: t('settings.subagents.modal.promptPlaceholder'),
      },
    });
    promptArea.value = this.existing?.prompt ?? '';

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
    saveBtn.addEventListener('click', () => {
      void (async (): Promise<void> => {
        const name = nameInput.value.trim();
        const nameError = validateKimiAgentName(name);
        if (nameError) {
          new Notice(nameError);
          return;
        }

        const description = descriptionInput.value.trim();
        if (!description) {
          new Notice(t('settings.subagents.descriptionRequired'));
          return;
        }

        const prompt = promptArea.value;
        if (!prompt.trim()) {
          new Notice(t('settings.subagents.promptRequired'));
          return;
        }

        const duplicate = findKimiAgentNameConflict(
          this.allAgents,
          name,
          this.existing?.filePath,
        );
        if (duplicate) {
          new Notice(t('settings.subagents.duplicateName', { name }));
          return;
        }

        try {
          await this.onSave(buildKimiAgentSavePayload({
            description,
            existing: this.existing,
            modelChoice: modelValue,
            name,
            prompt,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          new Notice(t('settings.subagents.saveFailed', { message }));
          return;
        }
        this.close();
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export interface KimiAgentSettingsDeps {
  app: App;
  onChanged?: () => Promise<void> | void;
  storage: Pick<KimiAgentStorage, 'delete' | 'loadAll' | 'save'>;
}

export class KimiAgentSettings {
  private agents: KimiAgentDefinition[] = [];

  constructor(
    private containerEl: HTMLElement,
    private deps: KimiAgentSettingsDeps,
  ) {
    void this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    try {
      this.agents = await this.deps.storage.loadAll();
    } catch {
      this.agents = [];
    }

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-sp-header' });
    headerEl.createSpan({ text: t('settings.subagents.name'), cls: 'claudian-sp-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-sp-header-actions' });

    const refreshBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.refresh') },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => {
      void this.render();
    });

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.add') },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openModal(null));

    if (this.agents.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText(t('settings.subagents.noAgents'));
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });
    for (const agent of this.agents) {
      this.renderItem(listEl, agent);
    }
  }

  private renderItem(listEl: HTMLElement, agent: KimiAgentDefinition): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });
    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });
    headerRow.createSpan({ cls: 'claudian-sp-item-name' }).setText(agent.name);
    if (agent.modelPreference) {
      headerRow.createSpan({ text: agent.modelPreference, cls: 'claudian-slash-item-badge' });
    }
    if (agent.description) {
      infoEl.createDiv({ cls: 'claudian-sp-item-desc' }).setText(agent.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-sp-item-actions' });

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('common.edit') },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openModal(agent));

    // Writes only target the brand directory, so generic-directory agents
    // cannot be deleted here.
    if (agent.filePath.startsWith(`${KIMI_BRAND_AGENTS_PATH}/`)) {
      const deleteBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
        attr: { 'aria-label': t('common.delete') },
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', () => {
        void this.deleteAgent(agent);
      });
    }
  }

  private openModal(existing: KimiAgentDefinition | null): void {
    new KimiAgentModal(
      this.deps.app,
      existing,
      this.agents,
      async (agent) => {
        await this.saveAgent(agent, existing);
      },
    ).open();
  }

  private async saveAgent(
    agent: KimiAgentDefinition,
    existing: KimiAgentDefinition | null,
  ): Promise<void> {
    await this.deps.storage.save(agent, existing);
    await this.render();
    await this.deps.onChanged?.();
    new Notice(
      existing
        ? t('settings.subagents.updated', { name: agent.name })
        : t('settings.subagents.created', { name: agent.name }),
    );
  }

  private async deleteAgent(agent: KimiAgentDefinition): Promise<void> {
    const confirmed = await confirmDelete(
      this.deps.app,
      t('settings.subagents.deleteConfirm', { name: agent.name }),
    );
    if (!confirmed) {
      return;
    }
    try {
      await this.deps.storage.delete(agent);
      await this.render();
      await this.deps.onChanged?.();
      new Notice(t('settings.subagents.deleted', { name: agent.name }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      new Notice(t('settings.subagents.deleteFailed', { message }));
    }
  }
}
