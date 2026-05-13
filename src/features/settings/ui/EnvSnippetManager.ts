import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import {
  getEnvironmentScopeUpdates,
  resolveEnvironmentSnippetScope,
} from '../../../core/providers/providerEnvironment';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import type { EnvironmentScope, EnvSnippet } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import type ClaudianPlugin from '../../../main';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import { formatContextLimit, parseContextLimit, parseEnvironmentVariables } from '../../../utils/env';
import type { ClaudianView } from '../../chat/ClaudianView';

export class EnvSnippetModal extends Modal {
  plugin: ClaudianPlugin;
  snippet: EnvSnippet | null;
  snippetScope: EnvironmentScope;
  onSave: (snippet: EnvSnippet) => void;

  constructor(
    app: App,
    plugin: ClaudianPlugin,
    snippet: EnvSnippet | null,
    scope: EnvironmentScope,
    onSave: (snippet: EnvSnippet) => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.snippet = snippet;
    this.snippetScope = scope;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle(this.snippet ? t('settings.envSnippets.modal.titleEdit') : t('settings.envSnippets.modal.titleSave'));

    this.modalEl.addClass('claudian-env-snippet-modal');

    let nameEl: HTMLInputElement;
    let descEl: HTMLInputElement;
    let envVarsEl: HTMLTextAreaElement;
    const contextLimitInputs: Map<string, HTMLInputElement> = new Map();
    let contextLimitsContainer: HTMLElement | null = null;

    // !e.isComposing for IME support (Chinese, Japanese, Korean, etc.)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        saveSnippet();
      } else if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        this.close();
      }
    };

    const saveSnippet = () => {
      const name = nameEl.value.trim();
      if (!name) {
        new Notice(t('settings.envSnippets.nameRequired'));
        return;
      }

      const contextLimits: Record<string, number> = {};
      for (const [modelId, input] of contextLimitInputs) {
        const value = input.value.trim();
        if (value) {
          const parsed = parseContextLimit(value);
          if (parsed !== null) {
            contextLimits[modelId] = parsed;
          }
        }
      }

      const snippet: EnvSnippet = {
        id: this.snippet?.id || `snippet-${Date.now()}`,
        name,
        description: descEl.value.trim(),
        envVars: envVarsEl.value,
        scope: resolveEnvironmentSnippetScope(
          envVarsEl.value,
          this.snippet?.scope ?? this.snippetScope,
        ),
        contextLimits: Object.keys(contextLimits).length > 0 ? contextLimits : undefined,
      };

      this.onSave(snippet);
      this.close();
    };

    const renderContextLimitFields = () => {
      if (!contextLimitsContainer) return;
      contextLimitsContainer.empty();
      contextLimitInputs.clear();

      const envVars = parseEnvironmentVariables(envVarsEl.value);
      const uniqueModelIds = ProviderRegistry.getCustomModelIds(envVars);

      if (uniqueModelIds.size === 0) {
        contextLimitsContainer.addClass('claudian-hidden');
        return;
      }

      contextLimitsContainer.removeClass('claudian-hidden');

      const existingLimits = this.snippet?.contextLimits ?? this.plugin.settings.customContextLimits ?? {};

      contextLimitsContainer.createEl('div', {
        text: t('settings.customContextLimits.name'),
        cls: 'setting-item-name',
      });
      contextLimitsContainer.createEl('div', {
        text: t('settings.customContextLimits.desc'),
        cls: 'setting-item-description',
      });

      for (const modelId of uniqueModelIds) {
        const row = contextLimitsContainer.createDiv({ cls: 'claudian-snippet-limit-row' });
        row.createSpan({ text: modelId, cls: 'claudian-snippet-limit-model' });
        row.createSpan({ cls: 'claudian-snippet-limit-spacer' });

        const input = row.createEl('input', {
          type: 'text',
          placeholder: '200k',
          cls: 'claudian-snippet-limit-input',
        });
        input.value = existingLimits[modelId] ? formatContextLimit(existingLimits[modelId]) : '';
        contextLimitInputs.set(modelId, input);
      }
    };

    new Setting(contentEl)
      .setName(t('settings.envSnippets.modal.name'))
      .setDesc(t('settings.envSnippets.modal.namePlaceholder'))
      .addText((text) => {
        nameEl = text.inputEl;
        text.setValue(this.snippet?.name || '');
                text.inputEl.addEventListener('keydown', handleKeyDown);
      });

    new Setting(contentEl)
      .setName(t('settings.envSnippets.modal.description'))
      .setDesc(t('settings.envSnippets.modal.descPlaceholder'))
      .addText((text) => {
        descEl = text.inputEl;
        text.setValue(this.snippet?.description || '');
                text.inputEl.addEventListener('keydown', handleKeyDown);
      });

    const envVarsSetting = new Setting(contentEl)
      .setName(t('settings.envSnippets.modal.envVars'))
      .setDesc(t('settings.envSnippets.modal.envVarsPlaceholder'))
      .addTextArea((text) => {
        envVarsEl = text.inputEl;
        const envVarsToShow = this.snippet?.envVars ?? this.plugin.getEnvironmentVariablesForScope(this.snippetScope);
        text.setValue(envVarsToShow);
        text.inputEl.rows = 8;
        text.inputEl.addEventListener('blur', () => renderContextLimitFields());
      });
    envVarsSetting.settingEl.addClass('claudian-env-snippet-setting');
    envVarsSetting.controlEl.addClass('claudian-env-snippet-control');

    contextLimitsContainer = contentEl.createDiv({ cls: 'claudian-snippet-context-limits' });
    renderContextLimitFields();

    const buttonContainer = contentEl.createDiv({ cls: 'claudian-snippet-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: t('settings.envSnippets.modal.cancel'),
      cls: 'claudian-cancel-btn'
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: this.snippet ? t('settings.envSnippets.modal.update') : t('settings.envSnippets.modal.save'),
      cls: 'claudian-save-btn'
    });
    saveBtn.addEventListener('click', () => saveSnippet());

    // Focus name input after modal is rendered (timeout for Windows compatibility)
    window.setTimeout(() => nameEl?.focus(), 50);
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class EnvSnippetManager {
  private containerEl: HTMLElement;
  private plugin: ClaudianPlugin;
  private scope: EnvironmentScope;
  private onContextLimitsChange?: () => void;

  constructor(
    containerEl: HTMLElement,
    plugin: ClaudianPlugin,
    scope: EnvironmentScope,
    onContextLimitsChange?: () => void,
  ) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.scope = scope;
    this.onContextLimitsChange = onContextLimitsChange;
    this.render();
  }

  private render() {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-snippet-header' });
    headerEl.createSpan({ text: t('settings.envSnippets.name'), cls: 'claudian-snippet-label' });

    const saveBtn = headerEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': t('settings.envSnippets.addBtn') },
    });
    setIcon(saveBtn, 'plus');
    saveBtn.addEventListener('click', () => {
      void this.saveCurrentEnv();
    });

    const snippets = this.plugin.settings.envSnippets.filter((snippet) => this.shouldDisplaySnippet(snippet));

    if (snippets.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-snippet-empty' });
      emptyEl.setText(t('settings.envSnippets.noSnippets'));
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-snippet-list' });

    for (const snippet of snippets) {
      const itemEl = listEl.createDiv({ cls: 'claudian-snippet-item' });

      const infoEl = itemEl.createDiv({ cls: 'claudian-snippet-info' });

      const nameEl = infoEl.createDiv({ cls: 'claudian-snippet-name' });
      nameEl.setText(snippet.name);

      if (snippet.description) {
        const descEl = infoEl.createDiv({ cls: 'claudian-snippet-description' });
        descEl.setText(snippet.description);
      }

      const actionsEl = itemEl.createDiv({ cls: 'claudian-snippet-actions' });

      const restoreBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': 'Insert' },
      });
      setIcon(restoreBtn, 'clipboard-paste');
      restoreBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
        try {
          await this.insertSnippet(snippet);
        } catch {
          new Notice('Failed to insert snippet');
        }
        })();
      });

      const editBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn',
        attr: { 'aria-label': 'Edit' },
      });
      setIcon(editBtn, 'pencil');
      editBtn.addEventListener('click', () => {
        this.editSnippet(snippet);
      });

      const deleteBtn = actionsEl.createEl('button', {
        cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
        attr: { 'aria-label': 'Delete' },
      });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', () => {
        void (async (): Promise<void> => {
        try {
          if (await confirmDelete(this.plugin.app, `Delete environment snippet "${snippet.name}"?`)) {
            await this.deleteSnippet(snippet);
          }
        } catch {
          new Notice('Failed to delete snippet');
        }
        })();
      });
    }
  }

  private async saveCurrentEnv() {
    const modal = new EnvSnippetModal(
      this.plugin.app,
      this.plugin,
      null,
      this.scope,
      (snippet) => {
        void (async (): Promise<void> => {
          this.plugin.settings.envSnippets.push(snippet);
          await this.plugin.saveSettings();
          this.render();
          new Notice(`Environment snippet "${snippet.name}" saved`);
        })();
      }
    );
    modal.open();
  }

  private async insertSnippet(snippet: EnvSnippet) {
    const snippetContent = snippet.envVars.trim();
    const updates = getEnvironmentScopeUpdates(
      snippetContent,
      snippet.scope ?? this.scope,
    );

    if (updates.length === 1) {
      const [update] = updates;
      this.syncTextareaValue(update.scope, update.envText);
      await this.plugin.applyEnvironmentVariables(update.scope, update.envText);
    } else if (updates.length > 1) {
      for (const update of updates) {
        this.syncTextareaValue(update.scope, update.envText);
      }
      await this.plugin.applyEnvironmentVariablesBatch(updates);
    }

    // Legacy snippets without contextLimits don't modify limits
    if (snippet.contextLimits) {
      this.plugin.settings.customContextLimits = {
        ...this.plugin.settings.customContextLimits,
        ...snippet.contextLimits,
      };
    }
    await this.plugin.saveSettings();

    this.onContextLimitsChange?.();
    const view = this.plugin.app.workspace.getLeavesOfType('claudian-view')[0]?.view as ClaudianView | undefined;
    view?.refreshModelSelector();
  }

  private editSnippet(snippet: EnvSnippet) {
    const modal = new EnvSnippetModal(
      this.plugin.app,
      this.plugin,
      snippet,
      this.scope,
      (updatedSnippet) => {
        void (async (): Promise<void> => {
          const index = this.plugin.settings.envSnippets.findIndex(s => s.id === snippet.id);
          if (index !== -1) {
            this.plugin.settings.envSnippets[index] = updatedSnippet;
            await this.plugin.saveSettings();
            this.render();
            new Notice(`Environment snippet "${updatedSnippet.name}" updated`);
          }
        })();
      }
    );
    modal.open();
  }

  private async deleteSnippet(snippet: EnvSnippet) {
    this.plugin.settings.envSnippets = this.plugin.settings.envSnippets.filter(s => s.id !== snippet.id);
    await this.plugin.saveSettings();
    this.render();
    new Notice(`Environment snippet "${snippet.name}" deleted`);
  }

  public refresh() {
    this.render();
  }

  private shouldDisplaySnippet(snippet: EnvSnippet): boolean {
    if (this.scope === 'shared') {
      return !snippet.scope || snippet.scope === 'shared';
    }

    return snippet.scope === this.scope;
  }

  private syncTextareaValue(scope: EnvironmentScope, value: string): void {
    const selector = `.claudian-settings-env-textarea[data-env-scope="${scope}"]`;
    const envTextarea = (this.containerEl.ownerDocument ?? window.document).querySelector<HTMLTextAreaElement>(selector);
    if (envTextarea) {
      envTextarea.value = value;
    }
  }
}
