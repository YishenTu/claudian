import type { App } from 'obsidian';
import { Modal } from 'obsidian';

import type { SkillRun } from '../../core/types';
import { getVaultPath, normalizePathForVault } from '../../utils/path';

export class SkillRunLogModal extends Modal {
  private run: SkillRun;

  constructor(app: App, run: SkillRun) {
    super(app);
    this.run = run;
  }

  onOpen(): void {
    this.setTitle(`/${this.run.skillName} log`);
    this.modalEl.addClass('claudian-run-log-modal');

    const metaEl = this.contentEl.createDiv({ cls: 'claudian-run-log-meta' });
    const vaultPath = getVaultPath(this.app);
    const workingDirectory = this.run.workingDirectory
      ? normalizePathForVault(this.run.workingDirectory, vaultPath) || '.'
      : 'vault root';
    metaEl.createDiv({
      text: `Working directory: ${workingDirectory}`,
    });
    metaEl.createDiv({
      text: `Status: ${this.run.status}`,
    });

    const logEl = this.contentEl.createEl('pre', {
      cls: 'claudian-run-log-output',
    });
    logEl.textContent = this.run.log?.trim() || 'No log output yet.';
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
