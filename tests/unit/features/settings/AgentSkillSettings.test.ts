/** @jest-environment jsdom */
import { MemoryDataAdapter } from '@test/helpers/MemoryDataAdapter';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';
import { Notice } from 'obsidian';

import { AgentSkillRepository } from '@/core/skills/AgentSkillRepository';
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
    adapter.addFile('.agents/skills/broken/SKILL.md', 'invalid');
    adapter.addFolder('.agents/skills/shared-skill/scripts');
    adapter.addFile('.agents/skills/shared-skill/scripts/run.py', 'example');
    await settings.refresh();
    expect(screen.getByText('.agents/skills/broken')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('common.delete') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('The entire skill folder, including scripts, references, and assets, will be moved to trash.')).toBeTruthy();
    expect((await axe(dialog)).violations).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: t('settings.agentSkills.delete.confirm') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await repository.list()).skills).toEqual([]);
    expect(adapter.trashed).toEqual(['.agents/skills/shared-skill']);
  });
});
