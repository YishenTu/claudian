import { DesktopVault } from '@test/helpers/core/DesktopVault';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { CLAUDE_COMMANDS_ROOT } from '@/features/agent-skills/AgentSkillRepository';
import {
  ClaudeCommandCollisionError,
  ClaudeCommandRepository,
  ClaudeCommandRevisionConflictError,
} from '@/features/agent-skills/ClaudeCommandRepository';
import { AgentSkillValidationError } from '@/features/agent-skills/validateAgentSkill';

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
  let vault: DesktopVault;
  let files: VaultFileAdapter;

  beforeEach(async () => {
    vault = await DesktopVault.create();
    files = vault.files;
    await vault.mkdir(CLAUDE_COMMANDS_ROOT);
  });

  afterEach(async () => {
    await vault.dispose();
  });

  function addCommand(relativePath: string, content: string): Promise<void> {
    return vault.write(`${CLAUDE_COMMANDS_ROOT}/${relativePath}`, content);
  }

  it('returns an empty list when the commands folder is missing', async () => {
    await vault.remove(CLAUDE_COMMANDS_ROOT);
    await expect(new ClaudeCommandRepository(files).list()).resolves.toEqual({
      commands: [],
      diagnostics: [],
    });
  });

  it('lists markdown commands recursively with nested names and optional frontmatter', async () => {
    await addCommand('review.md', REVIEW_COMMAND);
    await addCommand('git/commit.md', 'Commit the staged changes.\n');
    await addCommand('git/deep/push.md', '---\ndescription: Push\n---\nPush it.\n');
    await addCommand('notes.txt', 'ignored');

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
    await addCommand('review.md', REVIEW_COMMAND);
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
    await addCommand('review.md', REVIEW_COMMAND);
    const repository = new ClaudeCommandRepository(files, { frontmatterPolicy: 'portable' });
    const [loaded] = (await repository.list()).commands;

    const updated = await repository.update('review', loaded.revision, {
      name: 'review',
      description: 'Updated',
      instructions: 'Updated body.',
    });

    expect(updated.frontmatter).toEqual({ description: 'Updated' });
    const written = await vault.read(updated.filePath);
    expect(written).not.toContain('allowed-tools');
    expect(written).not.toContain('argument-hint');
  });

  it('writes no frontmatter block when nothing remains to store', async () => {
    await addCommand('plain.md', 'Plain body.\n');
    const repository = new ClaudeCommandRepository(files);
    const [loaded] = (await repository.list()).commands;

    const updated = await repository.update('plain', loaded.revision, {
      name: 'plain',
      description: '',
      instructions: 'New body.',
    });

    expect(await vault.read(updated.filePath)).toBe('New body.\n');
  });

  it.each([
    ['LF', '---\n---\nPrompt\n'],
    ['CRLF', '---\r\n---\r\nPrompt\r\n'],
  ])('keeps adjacent empty frontmatter delimiters out of the instructions (%s)', async (_label, source) => {
    await addCommand('empty.md', source);
    const repository = new ClaudeCommandRepository(files);

    const result = await repository.list();

    expect(result.diagnostics).toEqual([]);
    const [loaded] = result.commands;
    expect(loaded.frontmatter).toEqual({});
    expect(loaded.description).toBe('');
    expect(loaded.instructions).toBe('Prompt');

    await repository.update('empty', loaded.revision, {
      name: 'empty',
      description: '',
      instructions: 'Prompt',
    });
    expect(await vault.read(loaded.filePath)).toBe('Prompt\n');
  });

  it('treats a closing delimiter with trailing text as body instead of frontmatter', async () => {
    await addCommand('broken-close.md', '---\ndescription: test\n---suffix\nPrompt\n');
    const repository = new ClaudeCommandRepository(files);

    const result = await repository.list();

    expect(result.diagnostics).toEqual([]);
    const [loaded] = result.commands;
    expect(loaded.frontmatter).toEqual({});
    expect(loaded.description).toBe('');
    expect(loaded.instructions).toBe('---\ndescription: test\n---suffix\nPrompt');

    await repository.update('broken-close', loaded.revision, {
      name: 'broken-close',
      description: '',
      instructions: loaded.instructions,
    });
    expect(await vault.read(loaded.filePath)).toBe('---\ndescription: test\n---suffix\nPrompt\n');
  });

  it('accepts a closing delimiter at end of file', async () => {
    await addCommand('tail.md', '---\ndescription: test\n---');

    const result = await new ClaudeCommandRepository(files).list();

    expect(result.diagnostics).toEqual([]);
    expect(result.commands.map(command => [command.description, command.instructions])).toEqual([['test', '']]);
  });

  it.each<[string, string, string]>([
    ['LF-space', '---\ndescription: Example\nargument-hint: target\n--- \nPrompt', 'Prompt'],
    ['CRLF-tab', '---\r\ndescription: Example\r\nargument-hint: target\r\n---\t\r\nPrompt', 'Prompt'],
    ['padded-EOF', '---\ndescription: Example\nargument-hint: target\n--- \t', ''],
  ])('retains command metadata with a padded closing delimiter (%s)', async (_label, source, instructions) => {
    await addCommand('padded.md', source);

    const result = await new ClaudeCommandRepository(files).list();

    expect(result.diagnostics).toEqual([]);
    expect(result.commands.map(command => [
      command.description,
      command.frontmatter['argument-hint'],
      command.instructions,
    ])).toEqual([['Example', 'target', instructions]]);
    expect(await vault.read(`${CLAUDE_COMMANDS_ROOT}/padded.md`)).toBe(source);
  });

  it('renames into a nested path, prunes empty folders and rejects collisions', async () => {
    await addCommand('old/review.md', REVIEW_COMMAND);
    await addCommand('taken.md', 'Taken.\n');
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
    expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/old/review.md`)).toBe(false);
    expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/old`)).toBe(false);
    expect(await vault.exists(CLAUDE_COMMANDS_ROOT)).toBe(true);
  });

  it('validates renamed segments but tolerates an unchanged legacy name', async () => {
    await addCommand('Legacy_Name.md', 'Body.\n');
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

  it.each(['aux/review', 'team/lpt9'])(
    'rejects a device name in any renamed command segment: %s', async name => {
      await addCommand('review.md', REVIEW_COMMAND);
      const repository = new ClaudeCommandRepository(files);
      const [loaded] = (await repository.list()).commands;
      const original = await vault.snapshot();

      await expect(repository.update('review', loaded.revision, {
        name, description: 'Updated', instructions: 'Updated body.',
      })).rejects.toBeInstanceOf(AgentSkillValidationError);
      expect(await vault.snapshot()).toEqual(original);
    },
  );

  it('rejects stale updates and trashes only a current revision', async () => {
    await addCommand('review.md', REVIEW_COMMAND);
    const repository = new ClaudeCommandRepository(files);
    const [loaded] = (await repository.list()).commands;
    await vault.write(loaded.filePath, 'Changed elsewhere.\n');

    await expect(repository.update('review', loaded.revision, {
      name: 'review',
      description: 'Mine',
      instructions: 'Mine.',
    })).rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);
    await expect(repository.trash('review', loaded.revision))
      .rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);

    const [current] = (await repository.list()).commands;
    await repository.trash('review', current.revision);
    expect(vault.trashed).toEqual([`${CLAUDE_COMMANDS_ROOT}/review.md`]);
  });

  it('reports unreadable command files as diagnostics', async () => {
    await addCommand('good.md', 'Good.\n');
    await vault.mkdir(`${CLAUDE_COMMANDS_ROOT}/bad.md`);

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
