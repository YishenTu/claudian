import { t } from '@/i18n/i18n';

export type GitSetupResolution =
  | {
    readonly status: 'available';
    readonly version: string;
  }
  | {
    readonly status: 'incompatible';
    readonly missingCapabilities: readonly string[];
  }
  | {
    readonly status: 'missing';
  };

export interface GitInstallSupport {
  readonly agentPrompt: string;
  readonly guideUrl: string;
}

export interface GitSetupPanelOptions {
  readonly configuredPath: string;
  readonly copyText?: (text: string) => Promise<void>;
  readonly onRescan: () => Promise<GitSetupResolution>;
  readonly onSaveConfiguredPath: (
    path: string,
  ) => Promise<GitSetupResolution | void>;
  readonly platform?: NodeJS.Platform;
  readonly resolution: GitSetupResolution;
}

export function getGitInstallSupport(platform: NodeJS.Platform): GitInstallSupport {
  if (platform === 'win32') {
    return {
      agentPrompt: [
        'Install Git for Windows 2.38 or newer on this computer (not WSL).',
        'Before changing the system, explain the installation steps and ask me to confirm.',
        'Do not change global Git identity or credential settings or any Obsidian Vault.',
        'Use the official installer, verify with git --version, and report the native git.exe path.',
      ].join(' '),
      guideUrl: 'https://git-scm.com/download/win',
    };
  }
  if (platform === 'darwin') {
    return {
      agentPrompt: [
        'Install Native Git 2.38 or newer on this Mac using the official Git installer or Xcode Command Line Tools.',
        'Before changing the system, explain the installation steps and ask me to confirm.',
        'Do not change global Git identity or credential settings or any Obsidian Vault.',
        'Verify with git --version and report the executable path.',
      ].join(' '),
      guideUrl: 'https://git-scm.com/download/mac',
    };
  }
  return {
    agentPrompt: [
      'Install Native Git 2.38 or newer using the official package for this Linux distribution.',
      'Before changing the system, explain the installation steps and ask me to confirm.',
      'Do not change global Git identity or credential settings or any Obsidian Vault.',
      'Verify with git --version and report the executable path.',
    ].join(' '),
    guideUrl: 'https://git-scm.com/download/linux',
  };
}

export class GitSetupPanel {
  private readonly copyText: (text: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private resolution: GitSetupResolution;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly options: GitSetupPanelOptions,
  ) {
    this.copyText = options.copyText ?? (async text => {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable');
      }
      await navigator.clipboard.writeText(text);
    });
    this.platform = options.platform ?? process.platform;
    this.resolution = options.resolution;
  }

  render(): void {
    this.containerEl.replaceChildren();
    this.containerEl.classList.add('claudian-collab-git-setup');
    const heading = this.containerEl.createEl('h3', {
      text: t('collab.gitSetup.title'),
    });
    heading.classList.add('claudian-collab-git-title');

    const status = this.containerEl.createDiv({ cls: 'claudian-collab-git-status' });
    if (this.resolution.status === 'available') {
      status.classList.add('claudian-collab-git-status--ready');
      status.textContent = t('collab.gitSetup.ready', {
        version: this.resolution.version,
      });
    } else {
      status.classList.add('claudian-collab-git-status--blocked');
      status.textContent = this.resolution.status === 'incompatible'
        ? t('collab.gitSetup.incompatible')
        : t('collab.gitSetup.missing');
      if (
        this.resolution.status === 'incompatible'
        && this.resolution.missingCapabilities.length > 0
      ) {
        status.createDiv({
          cls: 'claudian-collab-git-capabilities',
          text: this.resolution.missingCapabilities.join(', '),
        });
      }
      this.renderInstallSupport();
    }

    const actions = this.containerEl.createDiv({ cls: 'claudian-collab-git-actions' });
    const rescanButton = actions.createEl('button', {
      attr: { 'data-action': 'rescan', type: 'button' },
      text: t('collab.gitSetup.rescan'),
    });
    rescanButton.addEventListener('click', () => {
      void this.rescan(rescanButton);
    });

    const pathRow = this.containerEl.createDiv({ cls: 'claudian-collab-git-path-row' });
    pathRow.createEl('label', {
      attr: { for: 'claudian-collab-git-path' },
      text: t('collab.gitSetup.manualPath'),
    });
    const pathInput = pathRow.createEl('input', {
      attr: {
        id: 'claudian-collab-git-path',
        type: 'text',
      },
      cls: 'claudian-collab-git-path',
      value: this.options.configuredPath,
    });
    pathInput.value = this.options.configuredPath;
    const saveButton = pathRow.createEl('button', {
      attr: { 'data-action': 'save-path', type: 'button' },
      text: t('collab.gitSetup.savePath'),
    });
    saveButton.addEventListener('click', () => {
      void this.savePath(pathInput.value, saveButton).catch(() => undefined);
    });
  }

  private renderInstallSupport(): void {
    const support = getGitInstallSupport(this.platform);
    const supportEl = this.containerEl.createDiv({ cls: 'claudian-collab-git-support' });
    supportEl.createEl('a', {
      attr: {
        href: support.guideUrl,
        rel: 'noopener noreferrer',
        target: '_blank',
      },
      cls: 'claudian-collab-git-guide',
      text: t('collab.gitSetup.officialGuide'),
    });
    supportEl.createDiv({
      cls: 'claudian-collab-git-prompt-label',
      text: t('collab.gitSetup.agentPrompt'),
    });
    const prompt = supportEl.createEl('textarea', {
      cls: 'claudian-collab-git-prompt',
    });
    prompt.readOnly = true;
    prompt.rows = 4;
    prompt.value = support.agentPrompt;
    const copyButton = supportEl.createEl('button', {
      attr: { 'data-action': 'copy-prompt', type: 'button' },
      text: t('collab.gitSetup.copyPrompt'),
    });
    copyButton.addEventListener('click', () => {
      void this.copyText(support.agentPrompt).catch(() => undefined);
    });
  }

  private async rescan(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      this.resolution = await this.options.onRescan();
      this.render();
    } catch {
      button.disabled = false;
    }
  }

  private async savePath(pathValue: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const resolution = await this.options.onSaveConfiguredPath(pathValue.trim());
      if (resolution) {
        this.resolution = resolution;
        this.render();
      }
    } finally {
      button.disabled = false;
    }
  }
}
