import { DesktopVault } from '@test/helpers/core/DesktopVault';

import type { AgentSkillDocument, AgentSkillInput } from '@/core/skills/AgentSkill';
import type { AgentSkillRepository } from '@/core/skills/AgentSkillRepository';
import {
  AgentSkillRepository as VaultAgentSkillRepository,
  AgentSkillRevisionConflictError,
  CLAUDE_COMMANDS_ROOT,
  CLAUDE_SKILLS_ROOT,
} from '@/core/skills/AgentSkillRepository';
import { ClaudeCommandRepository, ClaudeCommandRevisionConflictError } from '@/core/skills/ClaudeCommandRepository';
import { AgentSkillManagementCoordinator } from '@/features/settings/AgentSkillManagementCoordinator';

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
  it('uses one repository and refreshes every mounted panel after persistence', async () => {
    const repository = createRepository();
    const notifyAgentSkillsChanged = jest.fn().mockResolvedValue(undefined);
    const coordinator = new AgentSkillManagementCoordinator(
      repository,
      notifyAgentSkillsChanged,
    );
    const refreshA = jest.fn().mockResolvedValue(undefined);
    const refreshB = jest.fn().mockResolvedValue(undefined);
    coordinator.subscribe(refreshA);
    coordinator.subscribe(refreshB);

    const input: AgentSkillInput = {
      name: 'shared-skill',
      description: 'Shared description',
      instructions: 'Shared instructions',
    };
    const result = await coordinator.create(input);

    expect(repository.create).toHaveBeenCalledWith(input);
    expect(notifyAgentSkillsChanged).toHaveBeenCalledTimes(1);
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: makeSkill(), refreshFailed: false });
  });

  it('refreshes panels independently when provider invalidation fails', async () => {
    const repository = createRepository();
    const coordinator = new AgentSkillManagementCoordinator(
      repository,
      jest.fn().mockRejectedValue(new Error('provider refresh unavailable')),
    );
    const refresh = jest.fn().mockResolvedValue(undefined);
    coordinator.subscribe(refresh);

    const result = await coordinator.trash('shared-skill', 'revision-1');

    expect(repository.trash).toHaveBeenCalledWith('shared-skill', 'revision-1');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: undefined, refreshFailed: true });
  });

  it('removes individual subscribers and resets all subscriptions on rebuild', async () => {
    const coordinator = new AgentSkillManagementCoordinator(
      createRepository(),
      jest.fn().mockResolvedValue(undefined),
    );
    const refreshA = jest.fn().mockResolvedValue(undefined);
    const refreshB = jest.fn().mockResolvedValue(undefined);
    const unsubscribeA = coordinator.subscribe(refreshA);
    coordinator.subscribe(refreshB);

    unsubscribeA();
    await coordinator.create({
      name: 'shared-skill',
      description: 'Shared description',
      instructions: 'Shared instructions',
    });

    expect(refreshA).not.toHaveBeenCalled();
    expect(refreshB).toHaveBeenCalledTimes(1);

    coordinator.resetSubscriptions();
    await coordinator.create({
      name: 'shared-skill',
      description: 'Shared description',
      instructions: 'Shared instructions',
    });

    expect(refreshA).not.toHaveBeenCalled();
    expect(refreshB).toHaveBeenCalledTimes(1);
  });

  it('does not publish or refresh when persistence fails', async () => {
    const repository = createRepository();
    repository.update.mockRejectedValue(new Error('stale revision'));
    const notify = jest.fn().mockResolvedValue(undefined);
    const refresh = jest.fn().mockResolvedValue(undefined);
    const coordinator = new AgentSkillManagementCoordinator(repository, notify);
    coordinator.subscribe(refresh);

    await expect(coordinator.update('shared-skill', 'stale', {
      name: 'shared-skill',
      description: 'Changed',
      instructions: 'Changed',
    })).rejects.toThrow('stale revision');

    expect(notify).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
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

    it('removes the new skill when the command cannot be removed', async () => {
      const [command] = (await commands.list()).commands;
      jest.spyOn(commands, 'trash').mockRejectedValueOnce(new ClaudeCommandRevisionConflictError('deploy'));

      await expect(coordinator.convertCommand(command, input)).rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);

      expect(await vault.exists(`${CLAUDE_SKILLS_ROOT}/deploy`)).toBe(false);
      expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/deploy.md`)).toBe(true);
    });
  });
});
