import { MemoryDataAdapter } from '@test/helpers/MemoryDataAdapter';
import type { App } from 'obsidian';

import { CLAUDE_COMMANDS_ROOT } from '@/core/skills/AgentSkillRepository';
import {
  ClaudeCommandCollisionError,
  ClaudeCommandRepository,
  ClaudeCommandRevisionConflictError,
} from '@/core/skills/ClaudeCommandRepository';
import { AgentSkillValidationError } from '@/core/skills/validateAgentSkill';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

const REVIEW_COMMAND = [
  '---',
  'description: Review a change',
  'argument-hint: "[file]"',
  'allowed-tools: [Read, Grep]',
  '---',
  'Review $ARGUMENTS carefully.',
  '',
].join('\n');

describe('ClaudeCommandRepository', () => {
  let dataAdapter: MemoryDataAdapter;
  let files: VaultFileAdapter;

  beforeEach(() => {
    dataAdapter = new MemoryDataAdapter();
    files = new VaultFileAdapter({ vault: { adapter: dataAdapter } } as unknown as App);
    dataAdapter.addFolder('.claude');
    dataAdapter.addFolder(CLAUDE_COMMANDS_ROOT);
  });

  function addCommand(relativePath: string, content: string): void {
    const segments = relativePath.split('/');
    let current = CLAUDE_COMMANDS_ROOT;
    for (const segment of segments.slice(0, -1)) {
      current = `${current}/${segment}`;
      dataAdapter.addFolder(current);
    }
    dataAdapter.addFile(`${CLAUDE_COMMANDS_ROOT}/${relativePath}`, content);
  }

  it('returns an empty list when the commands folder is missing', async () => {
    dataAdapter.nodes.delete(CLAUDE_COMMANDS_ROOT);
    await expect(new ClaudeCommandRepository(files).list()).resolves.toEqual({
      commands: [],
      diagnostics: [],
    });
  });

  it('lists markdown commands recursively with nested names and optional frontmatter', async () => {
    addCommand('review.md', REVIEW_COMMAND);
    addCommand('git/commit.md', 'Commit the staged changes.\n');
    addCommand('git/deep/push.md', '---\ndescription: Push\n---\nPush it.\n');
    addCommand('notes.txt', 'ignored');

    const result = await new ClaudeCommandRepository(files).list();

    expect(result.diagnostics).toEqual([]);
    expect(result.commands.map(command => [command.name, command.description, command.instructions])).toEqual([
      ['git/commit', '', 'Commit the staged changes.'],
      ['git/deep/push', 'Push', 'Push it.'],
      ['review', 'Review a change', 'Review $ARGUMENTS carefully.'],
    ]);
    expect(result.commands[2].filePath).toBe(`${CLAUDE_COMMANDS_ROOT}/review.md`);
    expect(result.commands[2].frontmatter).toMatchObject({ 'allowed-tools': ['Read', 'Grep'] });
    expect(result.commands[2].revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps unedited frontmatter under the preserve policy', async () => {
    addCommand('review.md', REVIEW_COMMAND);
    const repository = new ClaudeCommandRepository(files);
    const [loaded] = (await repository.list()).commands;

    const updated = await repository.update('review', loaded.revision, {
      name: 'review',
      description: 'Updated',
      instructions: 'Updated body.',
    });

    expect(updated.frontmatter).toMatchObject({
      description: 'Updated',
      'argument-hint': '[file]',
      'allowed-tools': ['Read', 'Grep'],
    });
    expect(updated.instructions).toBe('Updated body.');
  });

  it('writes only the description under the portable policy', async () => {
    addCommand('review.md', REVIEW_COMMAND);
    const repository = new ClaudeCommandRepository(files, { frontmatterPolicy: 'portable' });
    const [loaded] = (await repository.list()).commands;

    const updated = await repository.update('review', loaded.revision, {
      name: 'review',
      description: 'Updated',
      instructions: 'Updated body.',
    });

    expect(updated.frontmatter).toEqual({ description: 'Updated' });
    const written = await dataAdapter.read(updated.filePath);
    expect(written).not.toContain('allowed-tools');
    expect(written).not.toContain('argument-hint');
  });

  it('writes no frontmatter block when nothing remains to store', async () => {
    addCommand('plain.md', 'Plain body.\n');
    const repository = new ClaudeCommandRepository(files);
    const [loaded] = (await repository.list()).commands;

    const updated = await repository.update('plain', loaded.revision, {
      name: 'plain',
      description: '',
      instructions: 'New body.',
    });

    expect(await dataAdapter.read(updated.filePath)).toBe('New body.\n');
  });

  it('renames into a nested path, prunes empty folders and rejects collisions', async () => {
    addCommand('old/review.md', REVIEW_COMMAND);
    addCommand('taken.md', 'Taken.\n');
    const repository = new ClaudeCommandRepository(files);
    const loaded = (await repository.list()).commands.find(command => command.name === 'old/review')!;

    await expect(repository.update('old/review', loaded.revision, {
      name: 'taken',
      description: 'Review a change',
      instructions: 'Body.',
    })).rejects.toBeInstanceOf(ClaudeCommandCollisionError);

    const renamed = await repository.update('old/review', loaded.revision, {
      name: 'team/review',
      description: 'Review a change',
      instructions: 'Body.',
    });

    expect(renamed.filePath).toBe(`${CLAUDE_COMMANDS_ROOT}/team/review.md`);
    expect(dataAdapter.nodes.has(`${CLAUDE_COMMANDS_ROOT}/old/review.md`)).toBe(false);
    expect(dataAdapter.nodes.has(`${CLAUDE_COMMANDS_ROOT}/old`)).toBe(false);
    expect(dataAdapter.nodes.has(CLAUDE_COMMANDS_ROOT)).toBe(true);
  });

  it('validates renamed segments but tolerates an unchanged legacy name', async () => {
    addCommand('Legacy_Name.md', 'Body.\n');
    const repository = new ClaudeCommandRepository(files);
    const [loaded] = (await repository.list()).commands;

    await expect(repository.update('Legacy_Name', loaded.revision, {
      name: 'Other_Name',
      description: '',
      instructions: 'Body.',
    })).rejects.toBeInstanceOf(AgentSkillValidationError);

    const updated = await repository.update('Legacy_Name', loaded.revision, {
      name: 'Legacy_Name',
      description: 'Now described',
      instructions: 'Body.',
    });
    expect(updated.description).toBe('Now described');
  });

  it('rejects stale updates and trashes only a current revision', async () => {
    addCommand('review.md', REVIEW_COMMAND);
    const repository = new ClaudeCommandRepository(files);
    const [loaded] = (await repository.list()).commands;
    dataAdapter.addFile(loaded.filePath, 'Changed elsewhere.\n');

    await expect(repository.update('review', loaded.revision, {
      name: 'review',
      description: 'Mine',
      instructions: 'Mine.',
    })).rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);
    await expect(repository.trash('review', loaded.revision))
      .rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);

    const [current] = (await repository.list()).commands;
    await repository.trash('review', current.revision);
    expect(dataAdapter.trashed).toEqual([`${CLAUDE_COMMANDS_ROOT}/review.md`]);
  });

  it('reports unreadable command files as diagnostics', async () => {
    addCommand('good.md', 'Good.\n');
    dataAdapter.addFolder(`${CLAUDE_COMMANDS_ROOT}/bad.md`);

    const result = await new ClaudeCommandRepository(files).list();

    expect(result.commands.map(command => command.name)).toEqual(['good']);
    expect(result.diagnostics).toEqual([]);

    const readFailure = new ClaudeCommandRepository({
      verifyManagedPath: jest.fn().mockResolvedValue(true),
      listManagedFolder: jest.fn().mockResolvedValue({
        files: [`${CLAUDE_COMMANDS_ROOT}/broken.md`],
        folders: [],
      }),
      readManagedFile: jest.fn().mockRejectedValue(new Error('unreadable')),
    } as unknown as VaultFileAdapter);
    await expect(readFailure.list()).resolves.toEqual({
      commands: [],
      diagnostics: [{ directoryPath: `${CLAUDE_COMMANDS_ROOT}/broken.md`, message: 'unreadable' }],
    });
  });
});
