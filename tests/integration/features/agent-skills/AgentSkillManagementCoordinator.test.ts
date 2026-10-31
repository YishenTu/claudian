import { chmod } from 'node:fs/promises';

import { DesktopVault } from '@test/helpers/core/DesktopVault';

import type { AgentSkillInput } from '@/features/agent-skills/AgentSkill';
import { AgentSkillManagementCoordinator } from '@/features/agent-skills/AgentSkillManagementCoordinator';
import {
  AgentSkillRepository,
  AgentSkillRevisionConflictError,
  CLAUDE_COMMANDS_ROOT,
  CLAUDE_SKILLS_ROOT,
} from '@/features/agent-skills/AgentSkillRepository';
import { ClaudeCommandRepository, ClaudeCommandRevisionConflictError } from '@/features/agent-skills/ClaudeCommandRepository';

describe('AgentSkillManagementCoordinator', () => {
  let vault: DesktopVault;
  let repository: AgentSkillRepository;
  const input: AgentSkillInput = {
    name: 'shared-skill', description: 'Shared description', instructions: 'Shared instructions',
  };

  beforeEach(async () => {
    vault = await DesktopVault.create();
    repository = new AgentSkillRepository(vault.files);
  });

  afterEach(async () => { await vault.dispose(); });

  it('persists once and then invalidates provider skill resources', async () => {
    const notify = vi.fn(async () => {
      // Provider invalidation can read the committed skill before it completes.
      expect((await repository.list()).skills[0]).toMatchObject(input);
    });
    const coordinator = new AgentSkillManagementCoordinator(repository, notify);
    const result = await coordinator.create(input);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: (await repository.list()).skills[0], refreshFailed: false });
  });

  it('reports a failed provider invalidation without failing the mutation', async () => {
    const skill = await repository.create(input);
    const coordinator = new AgentSkillManagementCoordinator(
      repository,
      async () => { throw new Error('provider refresh unavailable'); },
    );

    const result = await coordinator.trash(skill.name, skill.revision);

    expect(result).toEqual({ value: undefined, refreshFailed: true });
    expect((await repository.list()).skills).toEqual([]);
    expect(vault.trashed).toEqual(['.agents/skills/shared-skill']);
  });

  it('does not invalidate providers when persistence fails', async () => {
    const skill = await repository.create(input);
    const notify = vi.fn();
    const coordinator = new AgentSkillManagementCoordinator(repository, notify);

    await expect(coordinator.update(skill.name, `${skill.revision}-stale`, {
      ...input, description: 'Changed', instructions: 'Changed',
    })).rejects.toBeInstanceOf(AgentSkillRevisionConflictError);

    expect(notify).not.toHaveBeenCalled();
    expect((await repository.list()).skills[0]).toMatchObject(input);
  });

  describe('converting a command on a filesystem-backed vault', () => {
    let commands: ClaudeCommandRepository;
    let coordinator: AgentSkillManagementCoordinator;
    const input: AgentSkillInput = { name: 'deploy', description: 'Deploy', instructions: 'Deploy it' };

    beforeEach(async () => {
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, '---\ndescription: Deploy\n---\nDeploy it\n');
      commands = new ClaudeCommandRepository(vault.files);
      coordinator = new AgentSkillManagementCoordinator(
        new AgentSkillRepository(vault.files, { root: CLAUDE_SKILLS_ROOT, readPolicy: 'lenient' }),
        vi.fn(),
        commands,
      );
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
      vi.spyOn(commands, 'trash').mockRejectedValueOnce(new ClaudeCommandRevisionConflictError('deploy'));

      await expect(coordinator.convertCommand(command, input)).rejects.toBeInstanceOf(ClaudeCommandRevisionConflictError);

      expect(await vault.exists(`${CLAUDE_SKILLS_ROOT}/deploy`)).toBe(false);
      expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/deploy.md`)).toBe(true);
    });
  });
});
