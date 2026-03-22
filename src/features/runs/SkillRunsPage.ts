import type { EventRef } from 'obsidian';
import { Notice, setIcon } from 'obsidian';

import type { SkillRun, SlashCommand } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { SelectableDropdown } from '../../shared/components/SelectableDropdown';
import { VaultMentionDataProvider } from '../../shared/mention/VaultMentionDataProvider';
import { getVaultPath, normalizePathForVault } from '../../utils/path';
import { SkillRunLogModal } from './SkillRunLogModal';

interface SkillRunsPageCallbacks {
  openConversation: (conversationId: string) => Promise<void>;
}

interface WorkingDirectorySuggestion {
  value: string;
  label: string;
  description: string;
  score: number;
}

const MAX_WORKING_DIRECTORY_SUGGESTIONS = 12;

function formatRunStatus(status: SkillRun['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'needs_attention':
      return 'Needs attention';
    case 'cancelled':
      return 'Cancelled';
  }
}

function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return 'Just now';

  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function splitArgsLines(argsText: string): string[] {
  return argsText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function normalizeWorkingDirectoryInput(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/$/, '');
}

function shouldSuggestWorkingDirectory(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed === '.' || trimmed === './') return true;
  if (trimmed.startsWith('~')) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return false;
  return !trimmed.startsWith('/');
}

function scoreWorkingDirectorySuggestion(path: string, query: string): number {
  if (!query) return 100;
  if (path === query) return 1000;
  if (path.startsWith(`${query}/`)) return 900;
  if (path.startsWith(query)) return 800;

  const pathSegments = path.split('/');
  const querySegments = query.split('/');
  const lastPathSegment = pathSegments[pathSegments.length - 1] ?? path;
  const lastQuerySegment = querySegments[querySegments.length - 1] ?? query;

  if (lastQuerySegment && lastPathSegment.startsWith(lastQuerySegment)) return 700;
  if (path.includes(`/${query}`)) return 600;
  if (path.includes(query)) return 500;

  return -1;
}

export class SkillRunsPage {
  private plugin: ClaudianPlugin;
  private callbacks: SkillRunsPageCallbacks;
  private mentionDataProvider: VaultMentionDataProvider;
  private rootEl: HTMLElement;
  private headerEl: HTMLElement;
  private formEl: HTMLElement;
  private listSectionEl: HTMLElement;
  private listEl: HTMLElement;
  private skillSelectEl: HTMLSelectElement;
  private argsInputEl: HTMLTextAreaElement;
  private workingDirectoryInputEl: HTMLInputElement;
  private workingDirectoryDropdown: SelectableDropdown<WorkingDirectorySuggestion>;
  private startBtnEl: HTMLButtonElement;
  private startManyBtnEl: HTMLButtonElement;
  private refreshBtnEl: HTMLButtonElement;
  private runsCountEl: HTMLElement;
  private selectedSkillName = '';
  private availableSkills: SlashCommand[] = [];
  private workingDirectorySelectedIndex = 0;
  private isStarting = false;
  private unsubscribe: (() => void) | null = null;
  private eventRefs: EventRef[] = [];
  private hideWorkingDirectoryDropdownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parentEl: HTMLElement,
    plugin: ClaudianPlugin,
    callbacks: SkillRunsPageCallbacks
  ) {
    this.plugin = plugin;
    this.callbacks = callbacks;
    this.mentionDataProvider = new VaultMentionDataProvider(this.plugin.app);
    this.rootEl = parentEl.createDiv({ cls: 'claudian-runs-page' });

    this.headerEl = this.rootEl.createDiv({ cls: 'claudian-runs-page-header' });
    this.formEl = this.rootEl.createDiv({ cls: 'claudian-runs-form' });
    this.listSectionEl = this.rootEl.createDiv({ cls: 'claudian-runs-list-section' });
    this.listEl = document.createElement('div');
    this.listEl.classList.add('claudian-runs-list');

    this.buildHeader();
    this.buildForm();
    this.buildListSectionHeader();
    this.registerVaultListeners();

    this.unsubscribe = this.plugin.skillRunManager.subscribe(() => {
      this.renderRuns();
    });
  }

  async initialize(): Promise<void> {
    this.mentionDataProvider.initializeInBackground();
    await this.reloadSkills();
    this.renderRuns();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.hideWorkingDirectoryDropdownTimer !== null) {
      clearTimeout(this.hideWorkingDirectoryDropdownTimer);
      this.hideWorkingDirectoryDropdownTimer = null;
    }

    this.workingDirectoryDropdown.destroy();

    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    this.rootEl.remove();
  }

  setVisible(visible: boolean): void {
    this.rootEl.style.display = visible ? '' : 'none';
    if (!visible) {
      this.hideWorkingDirectorySuggestions();
    }
  }

  private buildHeader(): void {
    const titleWrap = this.headerEl.createDiv({ cls: 'claudian-runs-title-wrap' });
    titleWrap.createEl('h4', { text: 'Skill Runs', cls: 'claudian-runs-title' });

    this.refreshBtnEl = this.headerEl.createEl('button', {
      cls: 'claudian-runs-refresh',
      text: 'Refresh skills',
    });
    this.refreshBtnEl.addEventListener('click', () => {
      void this.reloadSkills();
    });
  }

  private buildListSectionHeader(): void {
    const sectionHeaderEl = this.listSectionEl.createDiv({
      cls: 'claudian-runs-section-header',
    });
    sectionHeaderEl.createDiv({ text: 'Runs', cls: 'claudian-runs-section-title' });
    this.runsCountEl = sectionHeaderEl.createDiv({ cls: 'claudian-runs-count' });
    this.listSectionEl.appendChild(this.listEl);
  }

  private buildForm(): void {
    const controlsEl = this.formEl.createDiv({ cls: 'claudian-runs-form-controls' });

    const skillField = controlsEl.createDiv({ cls: 'claudian-runs-field' });
    skillField.createEl('label', { text: 'Skill', cls: 'claudian-runs-label' });
    this.skillSelectEl = skillField.createEl('select', { cls: 'claudian-runs-select' });
    this.skillSelectEl.addEventListener('change', () => {
      this.selectedSkillName = this.skillSelectEl.value;
      this.updateStartButtons();
    });

    const workingDirectoryField = controlsEl.createDiv({ cls: 'claudian-runs-field' });
    workingDirectoryField.createEl('label', {
      text: 'Working directory',
      cls: 'claudian-runs-label',
    });
    const workingDirectoryInputWrap = workingDirectoryField.createDiv({
      cls: 'claudian-runs-working-directory-wrap',
    });
    this.workingDirectoryInputEl = workingDirectoryInputWrap.createEl('input', {
      cls: 'claudian-runs-select',
      attr: {
        type: 'text',
        placeholder: '. or papers/inbox',
      },
    });
    this.workingDirectoryDropdown = new SelectableDropdown<WorkingDirectorySuggestion>(
      workingDirectoryInputWrap,
      {
        listClassName: 'claudian-runs-path-dropdown',
        itemClassName: 'claudian-runs-path-item',
        emptyClassName: 'claudian-runs-path-empty',
      }
    );
    this.bindWorkingDirectoryAutocomplete();

    const argsField = controlsEl.createDiv({
      cls: 'claudian-runs-field claudian-runs-field--wide',
    });
    argsField.createEl('label', {
      text: 'Arguments',
      cls: 'claudian-runs-label',
    });
    this.argsInputEl = argsField.createEl('textarea', {
      cls: 'claudian-runs-input',
      attr: {
        rows: '3',
        placeholder: 'https://example.com/paper-a\nhttps://example.com/paper-b',
      },
    });
    this.argsInputEl.addEventListener('input', () => {
      this.updateStartButtons();
    });

    const hintEl = this.formEl.createDiv({ cls: 'claudian-runs-form-hint' });
    hintEl.setText('Most-used skills float to the top. Leave working directory blank to use the vault root.');

    const actionsEl = this.formEl.createDiv({ cls: 'claudian-runs-form-actions' });
    this.startBtnEl = actionsEl.createEl('button', {
      cls: 'mod-cta',
      text: 'Start run',
    });
    this.startBtnEl.addEventListener('click', () => {
      void this.handleStartSingle();
    });

    this.startManyBtnEl = actionsEl.createEl('button', {
      text: 'Start one per line',
    });
    this.startManyBtnEl.addEventListener('click', () => {
      void this.handleStartMany();
    });
  }

  private bindWorkingDirectoryAutocomplete(): void {
    this.workingDirectoryInputEl.addEventListener('focus', () => {
      this.showWorkingDirectorySuggestions();
    });

    this.workingDirectoryInputEl.addEventListener('click', () => {
      this.showWorkingDirectorySuggestions();
    });

    this.workingDirectoryInputEl.addEventListener('input', () => {
      this.showWorkingDirectorySuggestions();
    });

    this.workingDirectoryInputEl.addEventListener('keydown', (event) => {
      if (!this.workingDirectoryDropdown.isVisible()) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.workingDirectoryDropdown.moveSelection(1);
        this.workingDirectorySelectedIndex = this.workingDirectoryDropdown.getSelectedIndex();
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.workingDirectoryDropdown.moveSelection(-1);
        this.workingDirectorySelectedIndex = this.workingDirectoryDropdown.getSelectedIndex();
        return;
      }

      if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
        const selectedItem = this.workingDirectoryDropdown.getSelectedItem();
        if (!selectedItem) return;
        event.preventDefault();
        this.applyWorkingDirectorySuggestion(selectedItem);
        return;
      }

      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        this.hideWorkingDirectorySuggestions();
      }
    });

    this.workingDirectoryInputEl.addEventListener('blur', () => {
      this.hideWorkingDirectoryDropdownTimer = setTimeout(() => {
        this.hideWorkingDirectorySuggestions();
      }, 120);
    });
  }

  private registerVaultListeners(): void {
    this.eventRefs.push(
      this.plugin.app.vault.on('create', () => {
        this.mentionDataProvider.markFoldersDirty();
      }),
      this.plugin.app.vault.on('delete', () => {
        this.mentionDataProvider.markFoldersDirty();
      }),
      this.plugin.app.vault.on('rename', () => {
        this.mentionDataProvider.markFoldersDirty();
      })
    );
  }

  private async reloadSkills(): Promise<void> {
    this.refreshBtnEl.disabled = true;
    try {
      this.availableSkills = await this.plugin.skillRunManager.getAvailableSkills();
      if (!this.selectedSkillName || !this.availableSkills.some(skill => skill.name === this.selectedSkillName)) {
        this.selectedSkillName = this.availableSkills[0]?.name ?? '';
      }
      this.renderSkillOptions();
      this.updateStartButtons();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Failed to load skills');
    } finally {
      this.refreshBtnEl.disabled = false;
    }
  }

  private renderSkillOptions(): void {
    this.skillSelectEl.empty();

    if (this.availableSkills.length === 0) {
      const option = this.skillSelectEl.createEl('option', { text: 'No user-invocable skills found' });
      option.value = '';
      option.selected = true;
      this.skillSelectEl.disabled = true;
      return;
    }

    this.skillSelectEl.disabled = false;
    for (const skill of this.availableSkills) {
      const option = this.skillSelectEl.createEl('option', { text: `/${skill.name}` });
      option.value = skill.name;
      option.selected = skill.name === this.selectedSkillName;
    }
  }

  private updateStartButtons(): void {
    const hasSkill = !!this.selectedSkillName;
    const lines = splitArgsLines(this.argsInputEl.value);
    const hasAnyInput = this.argsInputEl.value.trim().length > 0;

    this.startBtnEl.disabled = this.isStarting || !hasSkill || !hasAnyInput;
    this.startManyBtnEl.disabled = this.isStarting || !hasSkill || lines.length < 2;
  }

  private async handleStartSingle(): Promise<void> {
    const args = this.argsInputEl.value.trim();
    if (!this.selectedSkillName || !args) {
      return;
    }

    this.isStarting = true;
    this.updateStartButtons();

    try {
      await this.plugin.skillRunManager.createAndStartRun(
        this.selectedSkillName,
        args,
        this.workingDirectoryInputEl.value
      );
      this.argsInputEl.value = '';
      await this.reloadSkills();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Failed to start run');
    } finally {
      this.isStarting = false;
      this.updateStartButtons();
    }
  }

  private async handleStartMany(): Promise<void> {
    const argsList = splitArgsLines(this.argsInputEl.value);
    if (!this.selectedSkillName || argsList.length < 2) {
      return;
    }

    this.isStarting = true;
    this.updateStartButtons();

    try {
      await this.plugin.skillRunManager.createAndStartRuns(
        this.selectedSkillName,
        argsList,
        this.workingDirectoryInputEl.value
      );
      this.argsInputEl.value = '';
      await this.reloadSkills();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Failed to start runs');
    } finally {
      this.isStarting = false;
      this.updateStartButtons();
    }
  }

  private showWorkingDirectorySuggestions(): void {
    if (!shouldSuggestWorkingDirectory(this.workingDirectoryInputEl.value)) {
      this.hideWorkingDirectorySuggestions();
      return;
    }

    if (this.hideWorkingDirectoryDropdownTimer !== null) {
      clearTimeout(this.hideWorkingDirectoryDropdownTimer);
      this.hideWorkingDirectoryDropdownTimer = null;
    }

    const suggestions = this.getWorkingDirectorySuggestions(this.workingDirectoryInputEl.value);
    this.workingDirectorySelectedIndex = 0;
    this.workingDirectoryDropdown.render({
      items: suggestions,
      selectedIndex: this.workingDirectorySelectedIndex,
      emptyText: 'No matching folders',
      renderItem: (item, itemEl) => {
        const iconEl = itemEl.createSpan({ cls: 'claudian-runs-path-item-icon' });
        setIcon(iconEl, 'folder');

        const textWrap = itemEl.createDiv({ cls: 'claudian-runs-path-item-text' });
        textWrap.createDiv({
          text: item.label,
          cls: 'claudian-runs-path-item-label',
        });
        textWrap.createDiv({
          text: item.description,
          cls: 'claudian-runs-path-item-description',
        });
      },
      onItemClick: (item) => {
        this.applyWorkingDirectorySuggestion(item);
      },
      onItemHover: (_item, index) => {
        this.workingDirectorySelectedIndex = index;
      },
    });
  }

  private hideWorkingDirectorySuggestions(): void {
    this.workingDirectoryDropdown.hide();
  }

  private applyWorkingDirectorySuggestion(item: WorkingDirectorySuggestion): void {
    this.workingDirectoryInputEl.value = item.value;
    this.hideWorkingDirectorySuggestions();
    this.workingDirectoryInputEl.focus();
  }

  private getWorkingDirectorySuggestions(rawValue: string): WorkingDirectorySuggestion[] {
    const query = normalizeWorkingDirectoryInput(rawValue);
    const folderSuggestions = this.mentionDataProvider.getCachedVaultFolders()
      .map(folder => folder.path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''))
      .filter(Boolean);

    const uniqueFolders = [...new Set(folderSuggestions)];
    const suggestions: WorkingDirectorySuggestion[] = [];

    if (!query || query === '.') {
      suggestions.push({
        value: '.',
        label: 'Vault root',
        description: '.',
        score: 1100,
      });
    }

    for (const folderPath of uniqueFolders) {
      const score = scoreWorkingDirectorySuggestion(folderPath, query);
      if (score < 0) continue;

      suggestions.push({
        value: folderPath,
        label: folderPath.split('/').pop() ?? folderPath,
        description: folderPath,
        score,
      });
    }

    if (query && query !== '.' && '.'.startsWith(query)) {
      suggestions.unshift({
        value: '.',
        label: 'Vault root',
        description: '.',
        score: 1100,
      });
    }

    return suggestions
      .sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        return a.description.localeCompare(b.description);
      })
      .slice(0, MAX_WORKING_DIRECTORY_SUGGESTIONS);
  }

  private renderRuns(): void {
    const runs = this.plugin.skillRunManager.getRuns();
    this.runsCountEl.setText(`${runs.length} run${runs.length === 1 ? '' : 's'}`);
    this.listEl.empty();

    if (runs.length === 0) {
      const emptyEl = this.listEl.createDiv({ cls: 'claudian-runs-empty' });
      emptyEl.createDiv({ text: 'No background runs yet.', cls: 'claudian-runs-empty-title' });
      emptyEl.createDiv({
        text: 'Pick a skill above and launch one item or many items in parallel.',
        cls: 'claudian-runs-empty-copy',
      });
      return;
    }

    for (const run of runs) {
      const isActive = run.status === 'running' || run.status === 'queued';
      const itemEl = this.listEl.createDiv({ cls: `claudian-run-item claudian-run-item--${run.status}` });

      const topRow = itemEl.createDiv({ cls: 'claudian-run-item-top' });
      const titleWrap = topRow.createDiv({ cls: 'claudian-run-item-title-wrap' });
      titleWrap.createDiv({
        text: `/${run.skillName}`,
        cls: 'claudian-run-item-skill',
      });
      if (run.args) {
        titleWrap.createDiv({
          text: run.args,
          cls: 'claudian-run-item-args',
        });
      }

      const statusWrap = topRow.createDiv({ cls: 'claudian-run-item-status-wrap' });
      statusWrap.createDiv({
        text: formatRunStatus(run.status),
        cls: `claudian-run-item-status claudian-run-item-status--${run.status}`,
      });
      statusWrap.createDiv({
        text: formatTimestamp(run.updatedAt),
        cls: 'claudian-run-item-time',
      });

      const displayText = isActive
        ? (run.lastLogLine || run.summary || 'Waiting for output…')
        : (run.summary || run.lastLogLine || run.error || '');

      if (displayText || run.workingDirectory || (run.error && run.status === 'failed')) {
        const bodyEl = itemEl.createDiv({ cls: 'claudian-run-item-body' });
        if (displayText) {
          bodyEl.createDiv({
            text: displayText,
            cls: 'claudian-run-item-summary',
          });
        }

        if (run.workingDirectory) {
          const dirEl = bodyEl.createDiv({ cls: 'claudian-run-item-dir' });
          const iconEl = dirEl.createSpan({ cls: 'claudian-run-item-detail-icon' });
          setIcon(iconEl, 'folder');
          dirEl.createSpan({
            text: this.getWorkingDirectoryDisplay(run.workingDirectory),
            cls: 'claudian-run-item-working-dir',
          });
        }

        if (run.error && run.status === 'failed') {
          bodyEl.createDiv({
            text: run.error,
            cls: 'claudian-run-item-error',
          });
        }
      }

      const actionsEl = itemEl.createDiv({ cls: 'claudian-run-item-actions' });

      const openBtn = actionsEl.createEl('button', { text: 'Chat' });
      if (isActive) {
        openBtn.disabled = true;
        openBtn.setAttribute('aria-label', 'Chat will be available once the run finishes');
        openBtn.title = 'Available after run finishes';
      } else {
        openBtn.addEventListener('click', () => {
          void this.callbacks.openConversation(run.conversationId);
        });
      }

      const logBtn = actionsEl.createEl('button', { text: 'Log' });
      logBtn.addEventListener('click', () => {
        new SkillRunLogModal(this.plugin.app, run).open();
      });

      if (isActive) {
        const cancelBtn = actionsEl.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
          void this.plugin.skillRunManager.cancelRun(run.id);
        });
      } else {
        const rerunBtn = actionsEl.createEl('button', { text: 'Run again' });
        rerunBtn.addEventListener('click', () => {
          void this.plugin.skillRunManager.createAndStartRun(
            run.skillName,
            run.args,
            run.workingDirectory
          );
          void this.reloadSkills();
        });
      }
    }
  }

  private getWorkingDirectoryDisplay(value: string): string {
    const vaultPath = getVaultPath(this.plugin.app);
    const relative = normalizePathForVault(value, vaultPath);
    return relative || '.';
  }
}
