/** @jest-environment jsdom */
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { clearWriteFaults, failWritesUnder } from '@test/helpers/core/fsWriteFaults';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';

import { AGENT_SKILLS_ROOT, CLAUDE_COMMANDS_ROOT, CLAUDE_SKILLS_ROOT } from '@/features/agent-skills/AgentSkillRepository';
import { ClaudeSkillSync } from '@/features/agent-skills/ClaudeSkillSync';
import { SkillSyncModal } from '@/features/agent-skills/SkillSyncModal';
import { t } from '@/i18n/i18n';

jest.mock('node:fs/promises', () => (
  jest.requireActual('@test/helpers/core/fsWriteFaults').createFsPromisesWithWriteFaults()
));

jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  ...jest.requireActual('@test/helpers/ObsidianSettingsDOM'),
  // Obsidian's parseYaml rejects invalid YAML; the shared mock does not.
  parseYaml: (source: string) => jest.requireActual('js-yaml').load(source),
}));

function skill(name: string, description = 'Description'): string {
  return `---\nname: ${name}\ndescription: ${description}\nallowed-tools: [Read]\n---\nInstructions\n`;
}

describe('SkillSyncModal', () => {
  let vault: DesktopVault;
  let sync: ClaudeSkillSync;
  let onFinished: jest.Mock;

  beforeEach(async () => {
    document.body.replaceChildren();
    vault = await DesktopVault.create();
    sync = new ClaudeSkillSync(vault.files);
    onFinished = jest.fn();
  });

  afterEach(async () => {
    clearWriteFaults();
    await vault.dispose();
  });

  async function open(): Promise<HTMLElement> {
    new SkillSyncModal({} as App, sync, onFinished).open();
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).queryByText(t('settings.skills.sync.loading'))).toBeNull());
    return dialog;
  }

  async function seedConflict(): Promise<void> {
    await vault.write(`${AGENT_SKILLS_ROOT}/review/SKILL.md`, skill('review', 'Shared'));
    await vault.write(`${CLAUDE_SKILLS_ROOT}/review/SKILL.md`, skill('review', 'Claude'));
    await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, '---\ndescription: Deploy\n---\nDeploy $ARGUMENTS\n');
  }

  it('describes creating a link when .claude/skills does not exist', async () => {
    const dialog = await open();

    expect(within(dialog).getByText(t('settings.skills.sync.linkBody'))).toBeTruthy();
    expect(within(dialog).queryByText(/replaced by a link/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.confirm') }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await expect(sync.readState()).resolves.toBe('linked');
  });

  it('explains Sync briefly and lists only items that need attention', async () => {
    await seedConflict();
    await vault.write(`${CLAUDE_SKILLS_ROOT}/tidy/SKILL.md`, skill('tidy'));
    await vault.write(`${CLAUDE_SKILLS_ROOT}/README.md`, 'stray');
    const dialog = await open();

    expect(within(dialog).getByText(t('settings.skills.sync.intro'))).toBeTruthy();
    expect(within(dialog).getByText(t('settings.skills.sync.pros.oneList'))).toBeTruthy();
    expect(within(dialog).getByText(t('settings.skills.sync.cons.dropped'))).toBeTruthy();
    expect(within(dialog).getByText(t('settings.skills.sync.cons.claudeSyntax', { names: 'deploy' }))).toBeTruthy();
    expect(within(dialog).queryByText(/move to \.agents\/skills/)).toBeNull();
    expect(within(dialog).getByRole('group', { name: 'review' })).toBeTruthy();
    expect(within(dialog).queryByRole('group', { name: 'tidy' })).toBeNull();
    expect(within(dialog).queryByRole('group', { name: '/deploy' })).toBeNull();
    expect(within(dialog).queryByText(/README/)).toBeNull();
  });

  it('shows only the fields a problem needs and marks the card ready once fixed', async () => {
    await vault.write(`${CLAUDE_SKILLS_ROOT}/no-desc/SKILL.md`, '---\nname: no-desc\n---\nBody\n');
    const dialog = await open();

    const card = within(dialog).getByRole('group', { name: 'no-desc' });
    expect(within(card).getByText(t('settings.skills.sync.problems.description'))).toBeTruthy();
    expect(within(card).queryByRole('textbox', { name: t('settings.skills.sync.nameField') })).toBeNull();
    const next = within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.input(within(card).getByRole('textbox', { name: t('settings.skills.sync.descriptionField') }), {
      target: { value: 'Now described' },
    });

    expect(within(card).getByText(t('settings.skills.sync.ready'))).toBeTruthy();
    expect(next.disabled).toBe(false);
  });

  it('shows every field an item needs, even when one error hides another', async () => {
    await vault.write(`${CLAUDE_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\nname: Bad_Name\n---\nBody\n');
    const dialog = await open();

    const card = within(dialog).getByRole('group', { name: 'Bad_Name' });
    fireEvent.input(within(card).getByRole('textbox', { name: t('settings.skills.sync.nameField') }), {
      target: { value: 'good-name' },
    });
    fireEvent.input(within(card).getByRole('textbox', { name: t('settings.skills.sync.descriptionField') }), {
      target: { value: 'Now described' },
    });

    expect(within(card).getByText(t('settings.skills.sync.ready'))).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no Fix for a command without instructions', async () => {
    await vault.write(`${CLAUDE_COMMANDS_ROOT}/empty.md`, '---\ndescription: Empty\n---\n');
    const dialog = await open();

    const card = within(dialog).getByRole('group', { name: '/empty' });
    expect(within(card).queryByRole('radio', { name: t('settings.skills.sync.options.fix') })).toBeNull();
    const next = within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);

    fireEvent.click(within(card).getByRole('radio', { name: t('settings.skills.sync.options.keep') }));

    expect(next.disabled).toBe(false);
  });

  it('asks before discarding a skill whose frontmatter cannot be read', async () => {
    await vault.write(`${CLAUDE_SKILLS_ROOT}/broken/SKILL.md`, '---\nname: broken\ndescription: Use when: x\n---\nBody\n');
    const dialog = await open();

    const card = within(dialog).getByRole('group', { name: 'broken' });
    expect(within(card).getByText(t('settings.skills.sync.problems.unreadable'))).toBeTruthy();
    expect(within(card).queryByRole('radio', { name: t('settings.skills.sync.options.fix') })).toBeNull();
    fireEvent.click(within(card).getByRole('radio', { name: t('settings.skills.sync.options.discard') }));

    expect((within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds the name field when another item is renamed onto a card that lacked it', async () => {
    await vault.write(`${CLAUDE_SKILLS_ROOT}/no-desc/SKILL.md`, '---\nname: no-desc\n---\nBody\n');
    await vault.write(`${CLAUDE_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\nname: Bad_Name\ndescription: Bad\n---\nBody\n');
    const dialog = await open();

    const bad = within(dialog).getByRole('group', { name: 'Bad_Name' });
    const input = within(bad).getByRole('textbox', { name: t('settings.skills.sync.nameField') });
    input.focus();
    fireEvent.input(input, { target: { value: 'no-desc' } });

    const noDesc = within(dialog).getByRole('group', { name: 'no-desc' });
    expect(within(noDesc).getByRole('textbox', { name: t('settings.skills.sync.nameField') })).toBeTruthy();
    const focused = within(within(dialog).getByRole('group', { name: 'Bad_Name' }))
      .getByRole('textbox', { name: t('settings.skills.sync.nameField') });
    expect(document.activeElement).toBe(focused);
  });

  it('reports a file at .claude/skills without asking to confirm', async () => {
    await vault.write(CLAUDE_SKILLS_ROOT, 'not a folder');
    const dialog = await open();

    expect(within(dialog).getByText(/is a file/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: t('settings.skills.sync.confirm') })).toBeNull();
  });

  it('adds a card when renaming one item onto another item', async () => {
    await seedConflict();
    const dialog = await open();

    const review = within(dialog).getByRole('group', { name: 'review' });
    fireEvent.input(within(review).getByRole('textbox', { name: t('settings.skills.sync.nameField') }), {
      target: { value: 'deploy' },
    });

    expect(within(dialog).getByRole('group', { name: '/deploy' })).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('converts commands and describes creating the link when .claude/skills is missing', async () => {
    await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, '---\ndescription: Deploy\n---\nDeploy it\n');
    const dialog = await open();

    expect(within(dialog).getByText(t('settings.skills.sync.nothingNeedsAttention'))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }));

    expect(within(dialog).getByText(t('settings.skills.sync.linkWithItemsBody'))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.confirm') }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/deploy/SKILL.md`)).toContain('Deploy it');
  });

  it('blocks Continue until a conflict is resolved by renaming', async () => {
    await seedConflict();
    const dialog = await open();

    const card = within(dialog).getByRole('group', { name: 'review' });
    expect(within(card).getByText(t('settings.skills.sync.problems.sharedConflict', { name: 'review' }))).toBeTruthy();
    const next = within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect((await axe(dialog)).violations).toEqual([]);

    fireEvent.input(within(card).getByRole('textbox', { name: t('settings.skills.sync.nameField') }), {
      target: { value: 'claude-review' },
    });

    expect(next.disabled).toBe(false);
  });

  it('confirms before linking and leaves the vault untouched when cancelled', async () => {
    await seedConflict();
    const dialog = await open();
    const card = within(dialog).getByRole('group', { name: 'review' });
    fireEvent.click(within(card).getByRole('radio', { name: t('settings.skills.sync.options.discard') }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }));

    expect(within(dialog).getByText(t('settings.skills.sync.devicesWarning'))).toBeTruthy();
    expect(within(dialog).getByText(t('settings.skills.sync.confirmBody'))).toBeTruthy();
    await expect(sync.readState()).resolves.toBe('folder');

    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }));

    expect(screen.queryByRole('dialog')).toBeNull();
    await expect(sync.readState()).resolves.toBe('folder');
    expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/review/SKILL.md`)).toBe(skill('review', 'Claude'));
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('syncs after confirmation and reports the result', async () => {
    await seedConflict();
    const dialog = await open();
    const card = within(dialog).getByRole('group', { name: 'review' });
    fireEvent.click(within(card).getByRole('radio', { name: t('settings.skills.sync.options.replace') }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.confirm') }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onFinished).toHaveBeenCalledTimes(1);
    await expect(sync.readState()).resolves.toBe('linked');
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/review/SKILL.md`)).toContain('Claude');
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/deploy/SKILL.md`)).not.toContain('allowed-tools');
  });

  it('lists failures and does not link when an item fails', async () => {
    await vault.write(`${CLAUDE_SKILLS_ROOT}/fails/SKILL.md`, skill('fails'));
    failWritesUnder(vault.resolve(`${AGENT_SKILLS_ROOT}/fails`));
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.continue') }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.skills.sync.confirm') }));

    expect(await within(dialog).findByText(t('settings.skills.sync.partial'))).toBeTruthy();
    expect(within(dialog).getByText(`${CLAUDE_SKILLS_ROOT}/fails`)).toBeTruthy();
    await expect(sync.readState()).resolves.toBe('folder');
  });
});
