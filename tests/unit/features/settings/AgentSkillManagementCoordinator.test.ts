import { chmod } from 'node:fs/promises';

import { DesktopVault } from '@test/helpers/core/DesktopVault';

import { AgentSkillManagementCoordinator } from '@/features/settings/AgentSkillManagementCoordinator';
import type { AgentSkillDocument, AgentSkillInput } from '@/features/settings/skills/AgentSkill';
import type { AgentSkillRepository } from '@/features/settings/skills/AgentSkillRepository';
import {
  AgentSkillRepository as VaultAgentSkillRepository,
  AgentSkillRevisionConflictError,
  CLAUDE_COMMANDS_ROOT,
  CLAUDE_SKILLS_ROOT,
} from '@/features/settings/skills/AgentSkillRepository';
import { ClaudeCommandRepository, ClaudeCommandRevisionConflictError } from '@/features/settings/skills/ClaudeCommandRepository';

function makeSkill(name = 'shared-skill', revision = 'revision-1'): AgentSkillDocument {
  return {
    name,
    description: 'Shared description',
    instructions: 'Shared instructions',
    frontmatter: { name, description: 'Shared description' },
    directoryPath: `.agents/skills/${name}`,
    filePath: `.agents/skills/${name}/SKILL.md`,
    revision,
  };
}

function createRepository() {
  const skill = makeSkill();
  return {
    list: jest.fn().mockResolvedValue({ skills: [skill], diagnostics: [] }),
    create: jest.fn().mockResolvedValue(skill),
    update: jest.fn().mockResolvedValue({ ...skill, revision: 'revision-2' }),
    trash: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AgentSkillRepository>;
}

describe('AgentSkillManagementCoordinator', () => {
  it('persists once and then invalidates provider skill resources', async () => {
    const repository = createRepository();
    const notifyAgentSkillsChanged = jest.fn().mockResolvedValue(undefined);
    const coordinator = new AgentSkillManagementCoordinator(
      repository,
      notifyAgentSkillsChanged,
    );

    const input: AgentSkillInput = {
      name: 'shared-skill',
      description: 'Shared description',
      instructions: 'Shared instructions',
    };
    const result = await coordinator.create(input);

    expect(repository.create).toHaveBeenCalledWith(input);
    expect(notifyAgentSkillsChanged).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: makeSkill(), refreshFailed: false });
  });

  it('reports a failed provider invalidation without failing the mutation', async () => {
    const repository = createRepository();
    const coordinator = new AgentSkillManagementCoordinator(
      repository,
      jest.fn().mockRejectedValue(new Error('provider refresh unavailable')),
    );

    const result = await coordinator.trash('shared-skill', 'revision-1');

    expect(repository.trash).toHaveBeenCalledWith('shared-skill', 'revision-1');
    expect(result).toEqual({ value: undefined, refreshFailed: true });
  });

  it('does not invalidate providers when persistence fails', async () => {
    const repository = createRepository();
    repository.update.mockRejectedValue(new Error('stale revision'));
    const notify = jest.fn().mockResolvedValue(undefined);
    const coordinator = new AgentSkillManagementCoordinator(repository, notify);

    await expect(coordinator.update('shared-skill', 'stale', {
      name: 'shared-skill',
      description: 'Changed',
      instructions: 'Changed',
    })).rejects.toThrow('stale revision');

    expect(notify).not.toHaveBeenCalled();
  });

  it('propagates one success and one revision conflict from two mounted panels', async () => {
    const repository = createRepository();
    repository.update
      .mockResolvedValueOnce(makeSkill('shared-skill', 'revision-2'))
      .mockRejectedValueOnce(new AgentSkillRevisionConflictError('shared-skill'));
    const coordinator = new AgentSkillManagementCoordinator(
      repository,
      jest.fn().mockResolvedValue(undefined),
    );
    const input: AgentSkillInput = {
      name: 'shared-skill',
      description: 'Changed',
      instructions: 'Changed',
    };

    const outcomes = await Promise.allSettled([
      coordinator.update('shared-skill', 'revision-1', input),
      coordinator.update('shared-skill', 'revision-1', input),
    ]);

    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toEqual(expect.objectContaining({
      status: 'rejected',
      reason: expect.any(AgentSkillRevisionConflictError),
    }));
  });

  describe('converting a command on a filesystem-backed vault', () => {
    let vault: DesktopVault;
    let commands: ClaudeCommandRepository;
    let coordinator: AgentSkillManagementCoordinator;
    const input: AgentSkillInput = { name: 'deploy', description: 'Deploy', instructions: 'Deploy it' };

    beforeEach(async () => {
      vault = await DesktopVault.create();
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, '---\ndescription: Deploy\n---\nDeploy it\n');
      commands = new ClaudeCommandRepository(vault.files);
      coordinator = new AgentSkillManagementCoordinator(
        new VaultAgentSkillRepository(vault.files, { root: CLAUDE_SKILLS_ROOT, readPolicy: 'lenient' }),
        jest.fn(),
        commands,
      );
    });

    afterEach(async () => {
      await vault.dispose();
    });

    it('creates nothing when the command changed after the draft was opened', async () => {
      const [command] = (await commands.list()).commands;
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, '---\ndescription: Deploy\n---\nEdited elsewhere\n');

      await expect(coordinator.convertCommand(command, input)).rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);

      expect(await vault.exists(`${CLAUDE_SKILLS_ROOT}/deploy`)).toBe(false);
      expect(await vault.read(`${CLAUDE_COMMANDS_ROOT}/deploy.md`)).toContain('Edited elsewhere');
      const [fresh] = (await commands.list()).commands;
      await expect(coordinator.convertCommand(fresh, input)).resolves.toBeTruthy();
      expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/deploy.md`)).toBe(false);
    });

    it('keeps the new skill when the command is trashed but its emptied folder cannot be removed', async () => {
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/ops/ship.md`, '---\ndescription: Ship\n---\nShip it\n');
      const command = (await commands.list()).commands.find(entry => entry.name === 'ops/ship')!;
      // A read-only parent refuses removal of the emptied `ops` folder, not the trash of the file.
      await chmod(vault.resolve(CLAUDE_COMMANDS_ROOT), 0o555);
      try {
        await expect(coordinator.convertCommand(command, { ...input, name: 'ops-ship' })).resolves.toBeTruthy();
      } finally {
        await chmod(vault.resolve(CLAUDE_COMMANDS_ROOT), 0o755);
      }

      expect(await vault.exists(`${CLAUDE_SKILLS_ROOT}/ops-ship/SKILL.md`)).toBe(true);
      expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/ops/ship.md`)).toBe(false);
    });

    it('removes the new skill when the command cannot be removed', async () => {
      const [command] = (await commands.list()).commands;
      jest.spyOn(commands, 'trash').mockRejectedValueOnce(new ClaudeCommandRevisionConflictError('deploy'));

      await expect(coordinator.convertCommand(command, input)).rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);

      expect(await vault.exists(`${CLAUDE_SKILLS_ROOT}/deploy`)).toBe(false);
      expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/deploy.md`)).toBe(true);
    });
  });
});
