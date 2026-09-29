/** @jest-environment jsdom */
import { MemoryDataAdapter } from '@test/helpers/MemoryDataAdapter';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import { AgentSkillRepository, CLAUDE_COMMANDS_ROOT, CLAUDE_SKILLS_ROOT, type SkillFrontmatterPolicy } from '@/core/skills/AgentSkillRepository';
import { ClaudeCommandRepository } from '@/core/skills/ClaudeCommandRepository';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { AgentSkillManagementCoordinator } from '@/features/settings/AgentSkillManagementCoordinator';
import { AgentSkillSettings } from '@/features/settings/AgentSkillSettings';
import { t } from '@/i18n/i18n';

jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  ...jest.requireActual('@test/helpers/ObsidianSettingsDOM'),
}));

function setup(notify: () => Promise<void> = async () => undefined) {
  const adapter = new MemoryDataAdapter();
  const app = { vault: { adapter } } as unknown as App;
  const repository = new AgentSkillRepository(new VaultFileAdapter(app));
  const coordinator = new AgentSkillManagementCoordinator(repository, notify);
  const container = document.body.appendChild(document.createElement('div'));
  const settings = new AgentSkillSettings(container, coordinator, app);
  return { adapter, container, coordinator, repository, settings };
}

async function openAdd() {
  fireEvent.click(await screen.findByRole('button', { name: t('common.add') }));
  return screen.getByRole('dialog');
}

function fill(dialog: HTMLElement, name = 'shared-skill') {
  const controls = within(dialog);
  fireEvent.input(controls.getByRole('textbox', { name: t('settings.agentSkills.modal.name') }), { target: { value: name } });
  fireEvent.input(controls.getByRole('textbox', { name: t('settings.agentSkills.modal.description') }), { target: { value: 'Shared description' } });
  fireEvent.input(controls.getByRole('textbox', { name: t('settings.agentSkills.modal.instructions') }), { target: { value: 'Shared instructions' } });
}

function save(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));
}

beforeEach(() => { document.body.replaceChildren(); jest.clearAllMocks(); });

describe('AgentSkillSettings', () => {
  it('creates a skill through named controls and preserves sibling settings', async () => {
    const { repository, container, settings } = setup();
    const sibling = container.appendChild(document.createElement('p'));
    sibling.textContent = 'Provider setup remains visible';
    const dialog = await openAdd();
    fill(dialog);
    expect((await axe(dialog)).violations).toEqual([]);
    save(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await repository.list()).skills).toEqual([expect.objectContaining({ name: 'shared-skill', instructions: 'Shared instructions' })]);
    expect(await screen.findByText('shared-skill')).toBeTruthy();
    await settings.refresh();
    expect(screen.getByText('Provider setup remains visible')).toBe(sibling);
  });

  it('keeps invalid input open with a validation notice', async () => {
    const { repository } = setup();
    const dialog = await openAdd();
    fill(dialog, 'Shared_Skill');
    save(dialog);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith(expect.stringContaining('lowercase')));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((await repository.list()).skills).toEqual([]);
  });

  it('preserves the draft if a loaded skill changes elsewhere', async () => {
    const { repository, settings } = setup();
    const skill = await repository.create({ name: 'shared-skill', description: 'Shared description', instructions: 'Original' });
    await settings.refresh();
    fireEvent.click(screen.getByRole('button', { name: t('common.edit') }));
    const dialog = screen.getByRole('dialog');
    fill(dialog);
    await repository.update(skill.name, skill.revision, { ...skill, instructions: 'External change' });
    save(dialog);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('This skill changed elsewhere; refresh before saving.'));
    expect((within(dialog).getByRole('textbox', { name: t('settings.agentSkills.modal.instructions') }) as HTMLTextAreaElement).value).toBe('Shared instructions');
    expect((await repository.list()).skills[0].instructions).toBe('External change');
  });

  it('reports durable success separately from provider refresh failure', async () => {
    const { repository } = setup(async () => { throw new Error('refresh unavailable'); });
    const dialog = await openAdd(); fill(dialog); save(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(Notice).toHaveBeenCalledWith('Saved, but provider refresh failed.');
    expect((await repository.list()).skills[0].name).toBe('shared-skill');
  });

  it('keeps a colliding draft open without overwriting the existing skill', async () => {
    const { repository } = setup();
    await repository.create({ name: 'shared-skill', description: 'Existing', instructions: 'Original' });
    const dialog = await openAdd(); fill(dialog); save(dialog);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('A skill named "shared-skill" already exists.'));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((await repository.list()).skills[0].instructions).toBe('Original');
  });

  it('hides private storage paths when saving fails', async () => {
    const { adapter } = setup();
    adapter.beforeWrite = () => { throw new Error('EACCES: /private/vault/.agents/skills/shared-skill/SKILL.md'); };
    const dialog = await openAdd(); fill(dialog); save(dialog);
    await waitFor(() => expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Failed to save shared skill:')));
    expect((Notice as jest.Mock).mock.calls.flat().join(' ')).not.toContain('/private/vault');
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('shows diagnostics and confirms deletion of the entire package', async () => {
    const { adapter, repository, settings } = setup();
    await repository.create({ name: 'shared-skill', description: 'Shared', instructions: 'Instructions' });
    adapter.addFolder('.agents/skills/broken');
    adapter.addFile('.agents/skills/broken/SKILL.md', '---\nname: broken\n---\nNo description\n');
    adapter.addFolder('.agents/skills/shared-skill/scripts');
    adapter.addFile('.agents/skills/shared-skill/scripts/run.py', 'example');
    await settings.refresh();
    expect(screen.getByText('.agents/skills/broken')).toBeTruthy();
    const skillRow = screen.getByText('shared-skill').closest('.claudian-sp-item') as HTMLElement;
    fireEvent.click(within(skillRow).getByRole('button', { name: t('common.delete') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('The entire skill folder, including scripts, references, and assets, will be moved to trash.')).toBeTruthy();
    expect((await axe(dialog)).violations).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.agentSkills.delete.confirm') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await repository.list()).skills).toEqual([]);
    expect(adapter.trashed).toEqual(['.agents/skills/shared-skill']);
  });
});

describe('AgentSkillSettings repair of flagged packages', () => {
  it('fixes a flagged package from a prefilled dialog', async () => {
    const { adapter, repository, settings } = setup();
    adapter.addFolder('.agents/skills/no-description');
    adapter.addFile('.agents/skills/no-description/SKILL.md', '---\nname: no-description\n---\nExisting instructions\n');
    await settings.refresh();

    const row = screen.getByText('.agents/skills/no-description').closest('.claudian-agent-skills-diagnostic') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: t('settings.agentSkills.fix') }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe(t('settings.agentSkills.modal.titleFix'));
    const controls = within(dialog);
    expect((controls.getByRole('textbox', { name: t('settings.agentSkills.modal.name') }) as HTMLInputElement).value).toBe('no-description');
    expect((controls.getByRole('textbox', { name: t('settings.agentSkills.modal.instructions') }) as HTMLTextAreaElement).value).toBe('Existing instructions');
    expect((await axe(dialog)).violations).toEqual([]);
    fireEvent.input(controls.getByRole('textbox', { name: t('settings.agentSkills.modal.description') }), { target: { value: 'Now described' } });
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const result = await repository.list();
    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([expect.objectContaining({ name: 'no-description', description: 'Now described' })]);
    await waitFor(() => expect(screen.queryByText('.agents/skills/no-description')).toBeNull());
  });

  it('lists only flagged packages the user can fix or delete', async () => {
    const { adapter, settings } = setup();
    adapter.addFolder('.agents/skills/fixable');
    adapter.addFile('.agents/skills/fixable/SKILL.md', '---\nname: fixable\n---\nBody\n');
    adapter.addFolder('.agents/skills/odd');
    adapter.addFolder('.agents/skills/odd/SKILL.md');
    adapter.addFolder('.agents/skills/plain');
    adapter.addFile('.agents/skills/plain/SKILL.md', 'No frontmatter\n');
    adapter.addFolder('.agents/skills/empty');
    await settings.refresh();

    expect(screen.getByText('.agents/skills/fixable')).toBeTruthy();
    expect(screen.queryByText('.agents/skills/odd')).toBeNull();
    expect(screen.queryByText('.agents/skills/plain')).toBeNull();
    expect(screen.queryByText('.agents/skills/empty')).toBeNull();

    adapter.nodes.delete('.agents/skills/fixable/SKILL.md');
    adapter.nodes.delete('.agents/skills/fixable');
    await settings.refresh();

    expect(screen.queryByText(t('settings.agentSkills.diagnosticsTitle'))).toBeNull();
  });

  it('moves a flagged package to trash after confirmation', async () => {
    const { adapter, settings } = setup();
    adapter.addFolder('.agents/skills/broken');
    adapter.addFile('.agents/skills/broken/SKILL.md', '---\nname: broken\n---\nBody\n');
    await settings.refresh();

    const row = screen.getByText('.agents/skills/broken').closest('.claudian-agent-skills-diagnostic') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: t('common.delete') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.agentSkills.delete.confirm') }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adapter.trashed).toEqual(['.agents/skills/broken']);
  });
});

describe('AgentSkillSettings with Claude commands and frontmatter policies', () => {
  function setupClaude(frontmatterPolicy: SkillFrontmatterPolicy) {
    const adapter = new MemoryDataAdapter();
    const app = { vault: { adapter } } as unknown as App;
    const files = new VaultFileAdapter(app);
    const repository = new AgentSkillRepository(files, {
      root: CLAUDE_SKILLS_ROOT,
      frontmatterPolicy,
      readPolicy: 'lenient',
    });
    const commands = new ClaudeCommandRepository(files, { frontmatterPolicy });
    const coordinator = new AgentSkillManagementCoordinator(repository, async () => undefined, commands);
    adapter.addFolder('.claude');
    adapter.addFolder(CLAUDE_SKILLS_ROOT);
    adapter.addFolder(CLAUDE_COMMANDS_ROOT);
    const container = document.body.appendChild(document.createElement('main'));
    const settings = new AgentSkillSettings(container, coordinator, app);
    return { adapter, repository, commands, settings };
  }

  function addSkillWithTools(adapter: MemoryDataAdapter) {
    adapter.addFolder(`${CLAUDE_SKILLS_ROOT}/reviewer`);
    adapter.addFile(
      `${CLAUDE_SKILLS_ROOT}/reviewer/SKILL.md`,
      '---\nname: reviewer\ndescription: Reviews\nallowed-tools: [Read]\n---\nReview it\n',
    );
  }

  const commandSource = '---\ndescription: Deploy app\nargument-hint: "[env]"\n---\nDeploy $ARGUMENTS\n';

  it('keeps unedited frontmatter when saving before sync', async () => {
    const { adapter, repository, settings } = setupClaude('preserve');
    addSkillWithTools(adapter);
    await settings.refresh();

    fireEvent.click(screen.getByRole('button', { name: t('common.edit') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/will be removed/)).toBeNull();
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await repository.list()).skills[0].frontmatter).toMatchObject({ 'allowed-tools': ['Read'] });
  });

  it('warns and removes other frontmatter when saving after sync', async () => {
    const { adapter, repository, settings } = setupClaude('portable');
    addSkillWithTools(adapter);
    await settings.refresh();

    fireEvent.click(screen.getByRole('button', { name: t('common.edit') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/allowed-tools/)).toBeTruthy();
    expect((await axe(dialog)).violations).toEqual([]);
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await repository.list()).skills[0].frontmatter).toEqual({ name: 'reviewer', description: 'Reviews' });
  });

  it('lists commands and converts one into a skill that keeps its frontmatter before sync', async () => {
    const { adapter, repository, commands, settings } = setupClaude('preserve');
    adapter.addFolder(`${CLAUDE_COMMANDS_ROOT}/ops`);
    adapter.addFile(`${CLAUDE_COMMANDS_ROOT}/ops/Deploy.md`, commandSource);
    await settings.refresh();

    expect(screen.getByText('/ops/Deploy')).toBeTruthy();
    expect((await axe(document.querySelector('main')!)).violations).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: t('settings.skills.commands.convert') }));
    const dialog = screen.getByRole('dialog');
    const name = within(dialog).getByRole('textbox', { name: t('settings.agentSkills.modal.name') }) as HTMLInputElement;
    expect(name.value).toBe('ops-deploy');
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [skill] = (await repository.list()).skills;
    expect(skill).toMatchObject({ name: 'ops-deploy', description: 'Deploy app', instructions: 'Deploy $ARGUMENTS' });
    expect(skill.frontmatter).toMatchObject({ 'argument-hint': '[env]' });
    expect((await commands.list()).commands).toEqual([]);
    expect(adapter.trashed).toEqual([`${CLAUDE_COMMANDS_ROOT}/ops/Deploy.md`]);
    await waitFor(() => expect(screen.queryByText('/ops/Deploy')).toBeNull());
    expect(screen.getByText('ops-deploy')).toBeTruthy();
  });

  it('strips command frontmatter when converting after sync', async () => {
    const { adapter, repository, settings } = setupClaude('portable');
    adapter.addFile(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, commandSource);
    await settings.refresh();

    fireEvent.click(screen.getByRole('button', { name: t('settings.skills.commands.convert') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/argument-hint/)).toBeTruthy();
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await repository.list()).skills[0].frontmatter).toEqual({ name: 'deploy', description: 'Deploy app' });
  });

  it('keeps the command when conversion collides with an existing skill', async () => {
    const { adapter, commands, settings } = setupClaude('preserve');
    addSkillWithTools(adapter);
    adapter.addFile(`${CLAUDE_COMMANDS_ROOT}/reviewer.md`, commandSource);
    await settings.refresh();

    fireEvent.click(screen.getByRole('button', { name: t('settings.skills.commands.convert') }));
    const dialog = screen.getByRole('dialog');
    save(dialog);

    await waitFor(() => expect(Notice).toHaveBeenCalledWith('A skill named "reviewer" already exists.'));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((await commands.list()).commands.map(command => command.name)).toEqual(['reviewer']);
  });

  it('edits a command description without touching its other frontmatter before sync', async () => {
    const { adapter, commands, settings } = setupClaude('preserve');
    adapter.addFile(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, commandSource);
    await settings.refresh();

    fireEvent.click(screen.getAllByRole('button', { name: t('common.edit') })[0]);
    const dialog = screen.getByRole('dialog');
    fireEvent.input(
      within(dialog).getByRole('textbox', { name: t('settings.agentSkills.modal.description') }),
      { target: { value: 'Ship it' } },
    );
    save(dialog);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [command] = (await commands.list()).commands;
    expect(command.frontmatter).toEqual({ description: 'Ship it', 'argument-hint': '[env]' });
  });
});
