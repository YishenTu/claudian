import { type App, Setting } from 'obsidian';

import { normalizeHiddenCommandList } from '../../core/providers/commands/hiddenCommands';
import {
  AGENT_SKILLS_ROOT,
  AgentSkillRepository,
  CLAUDE_SKILLS_ROOT,
} from '../../core/skills/AgentSkillRepository';
import { ClaudeCommandRepository } from '../../core/skills/ClaudeCommandRepository';
import { ClaudeSkillSync } from '../../core/skills/ClaudeSkillSync';
import type { FolderLinkState, VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import { t } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/types';
import type { FeatureHost } from '../FeatureHost';
import { AgentSkillManagementCoordinator } from './AgentSkillManagementCoordinator';
import { AgentSkillSettings, type AgentSkillSettingsOptions } from './AgentSkillSettings';
import { SkillSyncModal } from './SkillSyncModal';

type SkillsSubTab = 'claude' | 'shared';

export type SkillsSettingsHost = Pick<FeatureHost, 'settings' | 'mutateSettings' | 'notifyAgentSkillsChanged'>;


/**
 * Filesystem management for vault skills. The sync state is read from disk on
 * every render because a folder link is per device.
 */
export class SkillsSettingsTab {
  private activeSubTab: SkillsSubTab = 'claude';
  private renderGeneration = 0;
  private readonly panels: AgentSkillSettings[] = [];
  private readonly sync: ClaudeSkillSync;
  private readonly bodyEl: HTMLElement;

  constructor(
    containerEl: HTMLElement,
    private readonly app: App,
    private readonly files: VaultFileAdapter,
    private readonly host: SkillsSettingsHost,
  ) {
    this.sync = new ClaudeSkillSync(files);
    this.bodyEl = containerEl.createDiv({ cls: 'claudian-skills-tab' });
    this.#renderHiddenCommands(containerEl);
    void this.render();
  }

  dispose(): void {
    this.renderGeneration += 1;
    this.#disposePanels();
  }

  async render(): Promise<void> {
    const generation = ++this.renderGeneration;
    let state: FolderLinkState | null = null;
    let stateError: unknown = null;
    try {
      state = await this.sync.readState();
    } catch (error) {
      stateError = error;
    }
    if (generation !== this.renderGeneration) return;

    this.#disposePanels();
    this.bodyEl.empty();

    if (state === null) {
      this.bodyEl.createDiv({
        cls: 'claudian-skills-status',
        text: t('settings.skills.status.error', {
          message: stateError instanceof Error ? stateError.message : String(stateError),
        }),
      });
      return;
    }
    // The vault-wide flag says whether this vault was unified; the link on this
    // device is checked separately, so another device that lost the link gets Resync.
    const linked = state === 'linked';
    const synced = linked || this.host.settings.skillsSynced;
    if (!synced && (state === 'folder' || state === 'missing')) {
      this.#renderBeforeSync();
      return;
    }

    // After sync there is one list. A healthy link gets a green dot; anything else
    // at .claude/skills (missing, a broken or foreign link, a folder or a file) gets Resync.
    const policy = synced ? 'portable' : 'preserve';
    this.#renderPanel(
      this.bodyEl,
      new AgentSkillRepository(this.files, { frontmatterPolicy: policy }),
      new ClaudeCommandRepository(this.files, { frontmatterPolicy: policy }),
      {
        title: t('settings.tabs.skills'),
        help: null,
        // Leftover commands are the exception after sync, so show the section only when there are some.
        hideEmptyCommands: true,
        renderHeaderAccessory: actions => {
          if (linked) {
            actions.createSpan({
              cls: 'claudian-skills-synced-dot',
              attr: { role: 'img', 'aria-label': t('settings.skills.synced'), title: t('settings.skills.synced') },
            });
          } else {
            this.#renderSyncButton(actions, 'settings.skills.actions.resync');
          }
        },
      },
    );
  }

  #renderBeforeSync(): void {
    const subTabs = this.bodyEl.createDiv({ cls: 'claudian-settings-provider-tabs claudian-skills-subtabs' });
    const panelHost = this.bodyEl.createDiv({ cls: 'claudian-skills-subtab-content' });
    const buttons = new Map<SkillsSubTab, HTMLButtonElement>();
    const panels = new Map<SkillsSubTab, HTMLElement>();
    const select = (): void => {
      for (const [id, button] of buttons) {
        const active = id === this.activeSubTab;
        button.toggleClass('claudian-settings-provider-tab--active', active);
        button.setAttribute('aria-pressed', String(active));
        panels.get(id)?.toggleClass('claudian-settings-provider-content--active', active);
      }
    };
    for (const id of ['claude', 'shared'] as const) {
      const button = subTabs.createEl('button', {
        cls: 'claudian-settings-provider-tab',
        text: t(`settings.skills.subTabs.${id}`),
        attr: { type: 'button' },
      });
      buttons.set(id, button);
      panels.set(id, panelHost.createDiv({ cls: 'claudian-settings-provider-content' }));
      button.addEventListener('click', () => {
        this.activeSubTab = id;
        select();
      });
    }
    this.#renderSyncButton(subTabs.createDiv({ cls: 'claudian-skills-subtabs-actions' }), 'settings.skills.actions.sync');
    select();

    this.#renderPanel(
      panels.get('claude')!,
      new AgentSkillRepository(this.files, { root: CLAUDE_SKILLS_ROOT, readPolicy: 'lenient' }),
      new ClaudeCommandRepository(this.files),
      { help: t('settings.skills.claudeHelp') },
    );
    this.#renderPanel(
      panels.get('shared')!,
      new AgentSkillRepository(this.files, { root: AGENT_SKILLS_ROOT }),
      null,
      { help: t('settings.skills.sharedHelp') },
    );
  }

  #renderSyncButton(container: HTMLElement, labelKey: TranslationKey): void {
    const button = container.createEl('button', {
      cls: 'mod-cta',
      text: t(labelKey),
      attr: { type: 'button' },
    });
    button.addEventListener('click', () => {
      new SkillSyncModal(this.app, this.sync, result => {
        void (async () => {
          if (result?.linked && !this.host.settings.skillsSynced) {
            await this.host.mutateSettings(settings => { settings.skillsSynced = true; }).catch(() => undefined);
          }
          await this.render();
        })();
        void Promise.resolve(this.host.notifyAgentSkillsChanged()).catch(() => undefined);
      }).open();
    });
  }

  #renderPanel(
    container: HTMLElement,
    repository: AgentSkillRepository,
    commands: ClaudeCommandRepository | null,
    options: AgentSkillSettingsOptions,
  ): void {
    const coordinator = new AgentSkillManagementCoordinator(
      repository,
      () => this.host.notifyAgentSkillsChanged(),
      commands,
    );
    // Refresh re-reads the link state too, which can change outside Obsidian.
    this.panels.push(new AgentSkillSettings(container, coordinator, this.app, {
      ...options,
      onRefresh: () => void this.render(),
    }));
  }

  #renderHiddenCommands(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(t('settings.skills.hidden.name'))
      .setDesc(t('settings.skills.hidden.desc'))
      .setClass('claudian-settings-textarea')
      .setClass('claudian-skills-hidden-setting')
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.skills.hidden.placeholder'))
          .setValue(this.host.settings.hiddenCommands.join('\n'))
          .onChange(async (value) => {
            await this.host.mutateSettings((settings) => {
              settings.hiddenCommands = normalizeHiddenCommandList(value.split(/\r?\n/));
            });
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
        text.inputEl.setAttribute('aria-label', t('settings.skills.hidden.name'));
      });
  }

  #disposePanels(): void {
    for (const panel of this.panels) panel.dispose();
    this.panels.length = 0;
  }
}
