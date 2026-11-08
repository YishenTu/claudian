/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import type { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import type { ClaudianSettings } from '@/core/types';
import { AGENT_SKILLS_ROOT, CLAUDE_COMMANDS_ROOT, CLAUDE_SKILLS_ROOT } from '@/features/agent-skills/AgentSkillRepository';
import { ClaudeSkillSync } from '@/features/agent-skills/ClaudeSkillSync';
import { SkillsSettingsTab } from '@/features/agent-skills/SkillsSettingsTab';
import { setLocale, t } from '@/i18n/i18n';

function skill(name: string, description = 'Description'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nInstructions\n`;
}

describe('SkillsSettingsTab', () => {
  let vault: DesktopVault;
  let settings: ClaudianSettings;
  let tab: SkillsSettingsTab | null;
  let persist: ReturnType<typeof vi.fn<(draft: ClaudianSettings) => Promise<void>>>;
  let fixture: Awaited<ReturnType<typeof createFeatureHostFixture>>;

  beforeEach(async () => {
    document.body.replaceChildren();
    persist = vi.fn<(draft: ClaudianSettings) => Promise<void>>().mockResolvedValue(undefined);
    fixture = await createFeatureHostFixture({ settings: { hiddenCommands: ['compact'] }, beforePersist: persist });
    vault = fixture.vault;
    settings = fixture.settings;
    tab = null;
  });

  afterEach(async () => {
    persist.mockResolvedValue(undefined);
    tab?.dispose();
    await fixture.coordinator.mutateConditionally(() => false);
    await fixture.dispose();
    setLocale('en');
    vi.useRealTimers();
    vi.restoreAllMocks(); vi.clearAllMocks();
  });

  function render(): HTMLElement {
    const container = document.body.appendChild(document.createElement('main'));
    tab = new SkillsSettingsTab(container, fixture.host.app, vault.files, fixture.host);
    return container;
  }

  it('offers Resync instead of the before-sync view when this vault was synced on another device', async () => {
    settings.skillsSynced = true;
    await vault.write(`${AGENT_SKILLS_ROOT}/shared-one/SKILL.md`, skill('shared-one'));

    render();

    expect(await screen.findByText('shared-one')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('settings.skills.actions.resync') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('settings.skills.subTabs.claude') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('settings.skills.actions.sync') })).toBeNull();
  });

  it('records a successful sync in settings', async () => {
    render();

    fireEvent.click(await screen.findByRole('button', { name: t('settings.skills.actions.sync') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: t('settings.skills.sync.confirm') }));

    await waitFor(() => expect(settings.skillsSynced).toBe(true));
    expect(await screen.findByRole('img', { name: t('settings.skills.synced') })).toBeTruthy();
  });

  it('shows Claude and shared sub-tabs with commands before sync', async () => {
    await vault.write(`${CLAUDE_SKILLS_ROOT}/claude-only/SKILL.md`, skill('claude-only'));
    await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, 'Deploy it\n');
    await vault.write(`${AGENT_SKILLS_ROOT}/shared-one/SKILL.md`, skill('shared-one'));

    const container = render();

    const claudeTab = await screen.findByRole('button', { name: t('settings.skills.subTabs.claude') });
    const subTabBar = claudeTab.parentElement!;
    expect(subTabBar.contains(screen.getByRole('button', { name: t('settings.skills.actions.sync') }))).toBe(true);
    expect(subTabBar.querySelector('.claudian-skills-status-text')).toBeNull();
    const sharedTab = screen.getByRole('button', { name: t('settings.skills.subTabs.shared') });
    expect(claudeTab.getAttribute('aria-pressed')).toBe('true');
    expect(sharedTab.getAttribute('aria-pressed')).toBe('false');
    expect(await screen.findByText('claude-only')).toBeTruthy();
    expect(await screen.findByText('/deploy')).toBeTruthy();
    expect(await screen.findByText('shared-one')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('settings.skills.actions.sync') })).toBeTruthy();

    fireEvent.click(sharedTab);
    expect(sharedTab.getAttribute('aria-pressed')).toBe('true');
    expect(sharedTab.classList.contains('claudian-settings-provider-tab--active')).toBe(true);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows one list of shared skills and remaining commands after sync', async () => {
    await vault.write(`${AGENT_SKILLS_ROOT}/shared-one/SKILL.md`, skill('shared-one'));
    const sync = new ClaudeSkillSync(vault.files);
    await sync.execute(await sync.plan(), new Map());
    await vault.write(`${CLAUDE_COMMANDS_ROOT}/later.md`, 'Added after sync\n');

    render();

    const indicator = await screen.findByRole('img', { name: t('settings.skills.synced') });
    const refresh = screen.getByRole('button', { name: t('common.refresh') });
    expect(indicator.parentElement).toBe(refresh.parentElement);
    const title = screen.getByRole('heading', { name: t('settings.tabs.skills') });
    expect(title.closest('.claudian-agent-skills-header')).toBe(refresh.closest('.claudian-agent-skills-header'));
    expect(screen.queryByText(/links to \.agents\/skills/)).toBeNull();
    expect(await screen.findByText('shared-one')).toBeTruthy();
    expect(await screen.findByText('/later')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('settings.skills.subTabs.claude') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('settings.skills.actions.sync') })).toBeNull();
  });

  it('hides the empty command section after sync but keeps it before sync', async () => {
    await vault.write(`${AGENT_SKILLS_ROOT}/shared-one/SKILL.md`, skill('shared-one'));
    render();
    expect(await screen.findByText(t('settings.skills.commands.empty'))).toBeTruthy();
    tab?.dispose();
    document.body.replaceChildren();

    const sync = new ClaudeSkillSync(vault.files);
    await sync.execute(await sync.plan(), new Map());
    render();

    expect(await screen.findByText('shared-one')).toBeTruthy();
    expect(screen.queryByText(t('settings.skills.commands.title'))).toBeNull();
    expect(screen.queryByText(t('settings.skills.commands.empty'))).toBeNull();
  });

  it.each([
    ['foreign-link', 'elsewhere'],
    ['broken-link', 'gone'],
  ] as const)('shows the shared list with a Resync button for a %s', async (_state, target) => {
    await vault.mkdir('elsewhere');
    await vault.mkdir('.claude');
    await vault.symlink(CLAUDE_SKILLS_ROOT, vault.resolve(target));
    await vault.write(`${AGENT_SKILLS_ROOT}/shared-one/SKILL.md`, skill('shared-one'));

    render();

    expect(await screen.findByText('shared-one')).toBeTruthy();
    expect(screen.queryByText(t('settings.agentSkills.loadFailed'))).toBeNull();
    expect(screen.queryByRole('img', { name: t('settings.skills.synced') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('settings.skills.subTabs.claude') })).toBeNull();
    const resync = screen.getByRole('button', { name: t('settings.skills.actions.resync') });
    expect(resync.parentElement).toBe(screen.getByRole('button', { name: t('common.refresh') }).parentElement);
    fireEvent.click(resync);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(t('settings.skills.sync.repairBody'))).toBeTruthy();
  });

  it('re-reads the link state on Refresh', async () => {
    await vault.write(`${AGENT_SKILLS_ROOT}/shared-one/SKILL.md`, skill('shared-one'));
    const sync = new ClaudeSkillSync(vault.files);
    await sync.execute(await sync.plan(), new Map());
    settings.skillsSynced = true;
    render();
    expect(await screen.findByRole('img', { name: t('settings.skills.synced') })).toBeTruthy();

    await vault.files.removeFolderLink(CLAUDE_SKILLS_ROOT);
    fireEvent.click(screen.getByRole('button', { name: t('common.refresh') }));

    expect(await screen.findByRole('button', { name: t('settings.skills.actions.resync') })).toBeTruthy();
    expect(screen.queryByRole('img', { name: t('settings.skills.synced') })).toBeNull();
  });

  it('localizes a rejected hidden-command save and retries the retained draft on blur', async () => {
    await fixture.coordinator.mutate(draft => { draft.locale = 'zh-CN'; });
    setLocale('zh-CN');
    render();
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '隐藏的命令和技能' });
    const row = textarea.closest<HTMLElement>('.setting-item')!;
    const raw = '/review\nskill:review\n\nreview';
    persist.mockClear().mockRejectedValueOnce(new Error('Disk unavailable'));

    fireEvent.input(textarea, { target: { value: raw } });
    fireEvent.blur(textarea);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('保存设置失败'));
    expect(settings.hiddenCommands).toEqual(['compact']);
    expect((await fixture.settingsStorage.load()).hiddenCommands).toEqual(['compact']);
    expect(textarea.value).toBe(raw);

    fireEvent.focus(textarea);
    fireEvent.blur(textarea);
    await waitFor(() => expect(settings.hiddenCommands).toEqual(['review', 'skill:review']));
    await fixture.coordinator.mutateConditionally(() => false);
    expect((await fixture.settingsStorage.load()).hiddenCommands).toEqual(['review', 'skill:review']);
    expect(textarea.value).toBe(raw);
    expect(persist).toHaveBeenCalledTimes(2);
    expect((await axe(row, { runOnly: ['aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
  });

  it('edits the global hidden-command list', async () => {
    render();

    const textarea = screen.getByRole('textbox', { name: t('settings.skills.hidden.name') }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('compact');
    vi.useFakeTimers();
    fireEvent.input(textarea, { target: { value: '/review\nskill:review\n\nreview' } });
    expect(settings.hiddenCommands).toEqual(['compact']);
    await vi.advanceTimersByTimeAsync(500);
    await fixture.coordinator.mutateConditionally(() => false);
    expect(settings.hiddenCommands).toEqual(['review', 'skill:review']);
  });
});
