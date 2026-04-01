import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import type { CodexSubagentStorage } from '../storage/CodexSubagentStorage';
import type { CodexSubagentDefinition } from '../types/subagent';

const REASONING_EFFORT_OPTIONS = [
  { value: '', label: 'Inherit' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
] as const;

const SANDBOX_MODE_OPTIONS = [
  { value: '', label: 'Inherit' },
  { value: 'read-only', label: 'Read-only' },
  { value: 'danger-full-access', label: 'Danger full access' },
  { value: 'workspace-write', label: 'Workspace write' },
] as const;

const MAX_NAME_LENGTH = 64;
const CODEX_AGENT_NAME_PATTERN = /^[a-z0-9_-]+$/;
const CODEX_NICKNAME_PATTERN = /^[A-Za-z0-9 _-]+$/;

export function validateCodexSubagentName(name: string): string | null {
  if (!name) return 'Subagent name is required';
  if (name.length > MAX_NAME_LENGTH) return `Subagent name must be ${MAX_NAME_LENGTH} characters or fewer`;
  if (!CODEX_AGENT_NAME_PATTERN.test(name)) return 'Subagent name can only contain lowercase letters, numbers, hyphens, and underscores';
  return null;
}

export function validateCodexNicknameCandidates(candidates: string[]): string | null {
  const normalized = candidates.map(candidate => candidate.trim()).filter(Boolean);
  if (normalized.length === 0) return null;

  const seen = new Set<string>();
  for (const candidate of normalized) {
    if (!CODEX_NICKNAME_PATTERN.test(candidate)) {
      return 'Nickname candidates can only contain ASCII letters, numbers, spaces, hyphens, and underscores';
    }

    const dedupeKey = candidate.toLowerCase();
    if (seen.has(dedupeKey)) {
      return 'Nickname candidates must be unique';
    }
    seen.add(dedupeKey);
  }

  return null;
}

class CodexSubagentModal extends Modal {
  private existing: CodexSubagentDefinition | null;
  private allAgents: CodexSubagentDefinition[];
  private onSave: (agent: CodexSubagentDefinition) => Promise<void>;

  private _nameInput!: HTMLInputElement;
  private _descInput!: HTMLInputElement;
  private _instructionsArea!: HTMLTextAreaElement;
  private _nicknamesInput!: HTMLInputElement;
  private _modelInput!: HTMLInputElement;
  private _reasoningEffort = '';
  private _sandboxMode = '';
  private _triggerSave!: () => Promise<void>;

  constructor(
    app: App,
    existing: CodexSubagentDefinition | null,
    allAgents: CodexSubagentDefinition[],
    onSave: (agent: CodexSubagentDefinition) => Promise<void>,
  ) {
    super(app);
    this.existing = existing;
    this.allAgents = allAgents;
    this.onSave = onSave;
    this._reasoningEffort = existing?.modelReasoningEffort ?? '';
    this._sandboxMode = existing?.sandboxMode ?? '';
  }

  getTestInputs() {
    return {
      nameInput: this._nameInput,
      descInput: this._descInput,
      instructionsArea: this._instructionsArea,
      nicknamesInput: this._nicknamesInput,
      modelInput: this._modelInput,
      setReasoningEffort: (v: string) => { this._reasoningEffort = v; },
      setSandboxMode: (v: string) => { this._sandboxMode = v; },
      triggerSave: this._triggerSave,
    };
  }

  onOpen() {
    this.setTitle(this.existing ? 'Edit Codex Subagent' : 'Add Codex Subagent');
    this.modalEl.addClass('claudian-sp-modal');

    const { contentEl } = this;

    new Setting(contentEl)
      .setName('Name')
      .setDesc('Agent name Codex uses when spawning (lowercase, hyphens, underscores)')
      .addText(text => {
        this._nameInput = text.inputEl;
        text.setValue(this.existing?.name ?? '')
          .setPlaceholder('code_reviewer');
      });

    new Setting(contentEl)
      .setName('Description')
      .setDesc('When Codex should use this agent')
      .addText(text => {
        this._descInput = text.inputEl;
        text.setValue(this.existing?.description ?? '')
          .setPlaceholder('Reviews code for correctness and security');
      });

    // Advanced options
    const details = contentEl.createEl('details', { cls: 'claudian-sp-advanced-section' });
    details.createEl('summary', {
      text: 'Advanced options',
      cls: 'claudian-sp-advanced-summary',
    });
    if (
      this.existing?.model ||
      this.existing?.modelReasoningEffort ||
      this.existing?.sandboxMode ||
      this.existing?.nicknameCandidates?.length
    ) {
      details.open = true;
    }

    new Setting(details)
      .setName('Model')
      .setDesc('Model override (leave empty to inherit)')
      .addText(text => {
        this._modelInput = text.inputEl;
        text.setValue(this.existing?.model ?? '')
          .setPlaceholder('gpt-5.4');
      });

    new Setting(details)
      .setName('Reasoning effort')
      .setDesc('Model reasoning effort level')
      .addDropdown(dropdown => {
        for (const opt of REASONING_EFFORT_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }
        dropdown.setValue(this._reasoningEffort);
        dropdown.onChange(v => { this._reasoningEffort = v; });
      });

    new Setting(details)
      .setName('Sandbox mode')
      .setDesc('Sandbox restriction for this agent')
      .addDropdown(dropdown => {
        for (const opt of SANDBOX_MODE_OPTIONS) {
          dropdown.addOption(opt.value, opt.label);
        }
        dropdown.setValue(this._sandboxMode);
        dropdown.onChange(v => { this._sandboxMode = v; });
      });

    new Setting(details)
      .setName('Nickname candidates')
      .setDesc('Comma-separated display nicknames (e.g., Atlas, Delta, Echo)')
      .addText(text => {
        this._nicknamesInput = text.inputEl;
        text.setValue(this.existing?.nicknameCandidates?.join(', ') ?? '');
      });

    // Developer instructions
    new Setting(contentEl)
      .setName('Developer instructions')
      .setDesc('Core instructions that define the agent\'s behavior');

    const instructionsArea = contentEl.createEl('textarea', {
      cls: 'claudian-sp-content-area',
      attr: {
        rows: '10',
        placeholder: 'Review code like an owner.\nPrioritize correctness, security, and missing test coverage.',
      },
    });
    instructionsArea.value = this.existing?.developerInstructions ?? '';
    this._instructionsArea = instructionsArea;

    // Buttons
    const doSave = async () => {
      const name = this._nameInput.value.trim();
      const nameError = validateCodexSubagentName(name);
      if (nameError) {
        new Notice(nameError);
        return;
      }

      const description = this._descInput.value.trim();
      if (!description) {
        new Notice('Description is required');
        return;
      }

      const developerInstructions = this._instructionsArea.value;
      if (!developerInstructions.trim()) {
        new Notice('Developer instructions are required');
        return;
      }

      const nicknameCandidates = this._nicknamesInput.value
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const nicknameError = validateCodexNicknameCandidates(nicknameCandidates);
      if (nicknameError) {
        new Notice(nicknameError);
        return;
      }

      const duplicate = this.allAgents.find(
        a => a.name.toLowerCase() === name.toLowerCase() &&
             a.persistenceKey !== this.existing?.persistenceKey,
      );
      if (duplicate) {
        new Notice(`A subagent named "${name}" already exists`);
        return;
      }

      const agent: CodexSubagentDefinition = {
        name,
        description,
        developerInstructions,
        nicknameCandidates: nicknameCandidates.length > 0 ? nicknameCandidates : undefined,
        model: this._modelInput.value.trim() || undefined,
        modelReasoningEffort: this._reasoningEffort || undefined,
        sandboxMode: this._sandboxMode || undefined,
        persistenceKey: this.existing?.persistenceKey,
        extraFields: this.existing?.extraFields,
      };

      try {
        await this.onSave(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(`Failed to save subagent: ${message}`);
        return;
      }
      this.close();
    };
    this._triggerSave = doSave;

    const buttonContainer = contentEl.createDiv({ cls: 'claudian-sp-modal-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: 'Save',
      cls: 'claudian-save-btn',
    });
    saveBtn.addEventListener('click', doSave);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class CodexSubagentSettings {
  private containerEl: HTMLElement;
  private storage: CodexSubagentStorage;
  private agents: CodexSubagentDefinition[] = [];
  private app?: App;
  private onChanged?: () => void;

  constructor(containerEl: HTMLElement, storage: CodexSubagentStorage, app?: App, onChanged?: () => void) {
    this.containerEl = containerEl;
    this.storage = storage;
    this.app = app;
    this.onChanged = onChanged;
    this.render();
  }

  async render(): Promise<void> {
    this.containerEl.empty();

    try {
      this.agents = await this.storage.loadAll();
    } catch {
      this.agents = [];
    }

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-sp-header' });
    headerEl.createSpan({ text: 'Codex Subagents', cls: 'claudian-sp-label' });

    const actionsEl = headerEl.createDiv({ cls: 'claudian-sp-header-actions' });

    const refreshBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => { void this.render(); });

    const addBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Add' },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => this.openModal(null));

    if (this.agents.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-sp-empty-state' });
      emptyEl.setText('No Codex subagents in vault. Click + to create one.');
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-sp-list' });
    for (const agent of this.agents) {
      this.renderItem(listEl, agent);
    }
  }

  private renderItem(listEl: HTMLElement, agent: CodexSubagentDefinition): void {
    const itemEl = listEl.createDiv({ cls: 'claudian-sp-item' });
    const infoEl = itemEl.createDiv({ cls: 'claudian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'claudian-sp-item-header' });
    const nameEl = headerRow.createSpan({ cls: 'claudian-sp-item-name' });
    nameEl.setText(agent.name);

    if (agent.model) {
      headerRow.createSpan({ text: agent.model, cls: 'claudian-slash-item-badge' });
    }

    if (agent.description) {
      const descEl = infoEl.createDiv({ cls: 'claudian-sp-item-desc' });
      descEl.setText(agent.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'claudian-sp-item-actions' });

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Edit' },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openModal(agent));

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-settings-delete-btn',
      attr: { 'aria-label': 'Delete' },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      if (!this.app) return;
      const confirmed = await confirmDelete(
        this.app,
        `Delete subagent "${agent.name}"?`,
      );
      if (!confirmed) return;
      try {
        await this.storage.delete(agent);
        await this.render();
        this.onChanged?.();
        new Notice(`Subagent "${agent.name}" deleted`);
      } catch {
        new Notice('Failed to delete subagent');
      }
    });
  }

  private openModal(existing: CodexSubagentDefinition | null): void {
    if (!this.app) return;

    const modal = new CodexSubagentModal(
      this.app,
      existing,
      this.agents,
      async (agent) => {
        await this.storage.save(agent, existing);
        await this.render();
        this.onChanged?.();
        new Notice(
          existing
            ? `Subagent "${agent.name}" updated`
            : `Subagent "${agent.name}" created`,
        );
      },
    );
    modal.open();
  }
}
