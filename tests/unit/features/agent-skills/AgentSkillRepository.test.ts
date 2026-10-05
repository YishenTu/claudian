import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { MemoryDataAdapter } from '@test/helpers/MemoryDataAdapter';
import type { App } from 'obsidian';

import {
  ManagedResourceCollisionError,
  VaultFileAdapter,
} from '@/core/storage/VaultFileAdapter';
import {
  AGENT_SKILLS_ROOT,
  AgentSkillCollisionError,
  AgentSkillRepository,
  AgentSkillRevisionConflictError,
  CLAUDE_SKILLS_ROOT,
} from '@/features/agent-skills/AgentSkillRepository';
import { AgentSkillValidationError } from '@/features/agent-skills/validateAgentSkill';

function markdown(name: string, description = 'Description', instructions = 'Instructions'): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'license: MIT',
    'metadata: {"owner":"team"}',
    '---',
    instructions,
    '',
  ].join('\n');
}

describe('AgentSkillRepository', () => {
  let dataAdapter: MemoryDataAdapter;
  let vaultFiles: VaultFileAdapter;
  let repository: AgentSkillRepository;

  beforeEach(() => {
    dataAdapter = new MemoryDataAdapter();
    const app = { vault: { adapter: dataAdapter } } as unknown as App;
    vaultFiles = new VaultFileAdapter(app);
    repository = new AgentSkillRepository(vaultFiles);
  });

  function useMemoryRelocation(): void {
    jest.spyOn(vaultFiles, 'relocateManagedPackageNoReplace')
      .mockImplementation(async (source, target) => {
        if (await dataAdapter.exists(target)) {
          throw new ManagedResourceCollisionError(target);
        }
        await dataAdapter.rename(source, target);
      });
  }

  function addSkill(name: string, content = markdown(name)): void {
    dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/${name}`);
    dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/${name}/SKILL.md`, content);
  }

  it('validates each skill file once through the safe reader', async () => {
    addSkill('one'); addSkill('two');
    const verify = jest.spyOn(vaultFiles, 'verifyManagedPath');
    const result = await repository.list();
    expect(result.skills).toHaveLength(2);
    expect(verify.mock.calls.filter(([file]) => file.endsWith('/SKILL.md'))).toHaveLength(2);
  });

  it('lists only direct packages and returns sorted skills and diagnostics', async () => {
    addSkill('z-skill');
    addSkill('a-skill');
    dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/broken`);
    dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, 'not frontmatter');
    dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/missing`);
    dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/a-skill/nested`);
    dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/a-skill/nested/SKILL.md`, markdown('nested'));

    const result = await repository.list();

    expect(result.skills.map(skill => skill.name)).toEqual(['a-skill', 'z-skill']);
    expect(result.diagnostics.map(item => item.directoryPath)).toEqual([
      `${AGENT_SKILLS_ROOT}/broken`,
      `${AGENT_SKILLS_ROOT}/missing`,
    ]);
    expect(result.skills[0].revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats an unsafe managed root as fatal and unsafe child packages as diagnostics', async () => {
    const rootUnsafeFiles = {
      verifyManagedPath: jest.fn().mockRejectedValue(new Error('Managed resource must not be a symlink')),
    } as unknown as VaultFileAdapter;
    await expect(new AgentSkillRepository(rootUnsafeFiles).list()).rejects.toThrow('symlink');

    const childUnsafeFiles = {
      readManagedFile: jest.fn().mockRejectedValue(new Error('Managed resource must not be a symlink')),
      verifyManagedPath: jest.fn(async (candidate: string) => {
        if (candidate.endsWith('/unsafe')) throw new Error('Managed resource must not be a symlink');
        return true;
      }),
      listManagedFolderEntries: jest.fn().mockResolvedValue([
        { path: `${AGENT_SKILLS_ROOT}/unsafe`, type: 'folder' },
      ]),
    } as unknown as VaultFileAdapter;
    const result = await new AgentSkillRepository(childUnsafeFiles).list();
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      directoryPath: `${AGENT_SKILLS_ROOT}/unsafe`,
      message: 'Managed resource must not be a symlink',
    }]);
  });

  it('creates only the fixed shared path and rejects existing orphan folders', async () => {
    const created = await repository.create({
      name: 'portable-skill',
      description: 'Portable description',
      instructions: 'Portable instructions',
    });

    expect(created.directoryPath).toBe('.agents/skills/portable-skill');
    expect(created.filePath).toBe('.agents/skills/portable-skill/SKILL.md');
    expect(await dataAdapter.read(created.filePath)).toContain('portable-skill');

    dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/orphan`);
    await expect(repository.create({
      name: 'orphan',
      description: 'Description',
      instructions: 'Instructions',
    })).rejects.toBeInstanceOf(AgentSkillCollisionError);
  });

  it('rejects a target created during the exclusive claim race', async () => {
    dataAdapter.beforeMkdir = path => {
      if (path.endsWith('/racing')) dataAdapter.addFolder(path);
    };

    await expect(repository.create({
      name: 'racing',
      description: 'Description',
      instructions: 'Instructions',
    })).rejects.toBeInstanceOf(AgentSkillCollisionError);
    expect(dataAdapter.nodes.has(`${AGENT_SKILLS_ROOT}/racing/SKILL.md`)).toBe(false);
  });

  it('updates owned fields while preserving unknown metadata and ancillary files', async () => {
    addSkill('portable-skill');
    dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/portable-skill/script.ts`, 'export {};');
    const loaded = (await repository.list()).skills[0];

    const updated = await repository.update('portable-skill', loaded.revision, {
      name: 'portable-skill',
      description: 'Updated description',
      instructions: 'Updated instructions',
    });

    expect(updated.frontmatter).toMatchObject({ license: 'MIT', metadata: { owner: 'team' } });
    expect(await dataAdapter.read(`${AGENT_SKILLS_ROOT}/portable-skill/script.ts`)).toBe('export {};');
  });

  it('rejects a stale update after an external edit', async () => {
    addSkill('portable-skill');
    const loaded = (await repository.list()).skills[0];
    dataAdapter.addFile(loaded.filePath, markdown('portable-skill', 'Externally changed'));

    await expect(repository.update('portable-skill', loaded.revision, {
      name: 'portable-skill',
      description: 'My edit',
      instructions: 'My instructions',
    })).rejects.toBeInstanceOf(AgentSkillRevisionConflictError);
  });

  it('renames the whole package and rejects a pre-existing empty destination', async () => {
    useMemoryRelocation();
    addSkill('old-name');
    dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/old-name/assets`);
    dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/old-name/assets/example.txt`, 'asset');
    const loaded = (await repository.list()).skills[0];

    const renamed = await repository.update('old-name', loaded.revision, {
      name: 'new-name',
      description: 'Updated',
      instructions: 'Updated instructions',
    });

    expect(renamed.directoryPath).toBe(`${AGENT_SKILLS_ROOT}/new-name`);
    expect(await dataAdapter.read(`${AGENT_SKILLS_ROOT}/new-name/assets/example.txt`)).toBe('asset');
    expect(dataAdapter.nodes.has(`${AGENT_SKILLS_ROOT}/old-name`)).toBe(false);

    addSkill('source-name');
    dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/occupied`);
    const source = (await repository.list()).skills.find(skill => skill.name === 'source-name')!;
    await expect(repository.update('source-name', source.revision, {
      name: 'occupied',
      description: 'Description',
      instructions: 'Instructions',
    })).rejects.toBeInstanceOf(AgentSkillCollisionError);
  });

  it('restores the original package and content when the renamed write fails', async () => {
    useMemoryRelocation();
    addSkill('old-name');
    dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/old-name/reference.txt`, 'reference');
    const loaded = (await repository.list()).skills[0];
    dataAdapter.beforeWrite = path => {
      if (path === `${AGENT_SKILLS_ROOT}/new-name/SKILL.md`) throw new Error('write failed');
    };

    await expect(repository.update('old-name', loaded.revision, {
      name: 'new-name',
      description: 'Updated',
      instructions: 'Updated instructions',
    })).rejects.toThrow('Could not write managed resource');

    expect(await dataAdapter.read(`${AGENT_SKILLS_ROOT}/old-name/SKILL.md`)).toBe(markdown('old-name'));
    expect(await dataAdapter.read(`${AGENT_SKILLS_ROOT}/old-name/reference.txt`)).toBe('reference');
    expect(dataAdapter.nodes.has(`${AGENT_SKILLS_ROOT}/new-name`)).toBe(false);
  });

  it('rechecks the revision before trashing the whole validated package', async () => {
    addSkill('portable-skill');
    dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/portable-skill/asset.txt`, 'asset');
    const loaded = (await repository.list()).skills[0];
    dataAdapter.addFile(loaded.filePath, markdown('portable-skill', 'External edit'));

    await expect(repository.trash('portable-skill', loaded.revision))
      .rejects.toBeInstanceOf(AgentSkillRevisionConflictError);
    expect(dataAdapter.trashed).toEqual([]);

    const refreshed = (await repository.list()).skills[0];
    await repository.trash('portable-skill', refreshed.revision);
    expect(dataAdapter.trashed).toEqual([`${AGENT_SKILLS_ROOT}/portable-skill`]);
    expect(dataAdapter.nodes.has(`${AGENT_SKILLS_ROOT}/portable-skill/asset.txt`)).toBe(false);
  });

  it('serializes concurrent updates so only one loaded revision succeeds', async () => {
    addSkill('portable-skill');
    const loaded = (await repository.list()).skills[0];

    const results = await Promise.allSettled([
      repository.update('portable-skill', loaded.revision, {
        name: 'portable-skill', description: 'First', instructions: 'First instructions',
      }),
      repository.update('portable-skill', loaded.revision, {
        name: 'portable-skill', description: 'Second', instructions: 'Second instructions',
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AgentSkillRevisionConflictError);
  });

  it('serializes concurrent creates so only one claims the package', async () => {
    const input = {
      name: 'portable-skill', description: 'Description', instructions: 'Instructions',
    };

    const results = await Promise.allSettled([
      repository.create(input),
      repository.create(input),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AgentSkillCollisionError);
  });
  describe('root and frontmatter policies', () => {
    function claudeRepository(frontmatterPolicy: 'preserve' | 'portable' = 'preserve') {
      return new AgentSkillRepository(vaultFiles, {
        root: CLAUDE_SKILLS_ROOT,
        frontmatterPolicy,
        readPolicy: 'lenient',
      });
    }

    it('returns an empty list when an ancestor of the root is missing', async () => {
      await expect(claudeRepository().list()).resolves.toEqual({ skills: [], diagnostics: [] });
    });

    it('creates, updates and trashes packages under a configured root', async () => {
      const repo = claudeRepository();
      const created = await repo.create({
        name: 'claude-skill',
        description: 'Claude description',
        instructions: 'Claude instructions',
      });
      expect(created.filePath).toBe(`${CLAUDE_SKILLS_ROOT}/claude-skill/SKILL.md`);
      expect(dataAdapter.nodes.has(`${AGENT_SKILLS_ROOT}/claude-skill`)).toBe(false);

      const updated = await repo.update('claude-skill', created.revision, {
        name: 'claude-skill',
        description: 'Updated',
        instructions: 'Updated instructions',
      });
      expect((await repo.list()).skills.map(skill => skill.description)).toEqual(['Updated']);

      await repo.trash('claude-skill', updated.revision);
      expect(dataAdapter.trashed).toEqual([`${CLAUDE_SKILLS_ROOT}/claude-skill`]);
    });

    it('removes unknown frontmatter on update under the portable policy', async () => {
      addSkill('portable-skill');
      const portable = new AgentSkillRepository(vaultFiles, { frontmatterPolicy: 'portable' });
      const loaded = (await portable.list()).skills[0];
      expect(loaded.frontmatter).toMatchObject({ license: 'MIT' });

      const updated = await portable.update('portable-skill', loaded.revision, {
        name: 'portable-skill',
        description: 'Updated description',
        instructions: 'Updated instructions',
      });

      expect(updated.frontmatter).toEqual({
        name: 'portable-skill',
        description: 'Updated description',
      });
      expect(await dataAdapter.read(updated.filePath)).not.toContain('license');
    });

    it('lists lenient packages without a matching name or description, but not files without frontmatter', async () => {
      dataAdapter.addFolder('.claude');
      dataAdapter.addFolder(CLAUDE_SKILLS_ROOT);
      dataAdapter.addFolder(`${CLAUDE_SKILLS_ROOT}/Legacy_Skill`);
      dataAdapter.addFile(
        `${CLAUDE_SKILLS_ROOT}/Legacy_Skill/SKILL.md`,
        '---\nallowed-tools: [Read]\n---\nLegacy instructions\n',
      );
      dataAdapter.addFolder(`${CLAUDE_SKILLS_ROOT}/no-frontmatter`);
      dataAdapter.addFile(`${CLAUDE_SKILLS_ROOT}/no-frontmatter/SKILL.md`, 'Plain instructions\n');

      const repo = claudeRepository();
      const result = await repo.list();

      expect(result.diagnostics.map(item => [item.directoryPath, item.repairName])).toEqual([
        [`${CLAUDE_SKILLS_ROOT}/no-frontmatter`, undefined],
      ]);
      expect(result.skills.map(skill => [skill.name, skill.description, skill.instructions])).toEqual([
        ['Legacy_Skill', '', 'Legacy instructions'],
      ]);

      const legacy = result.skills[0];
      await expect(repo.update('Legacy_Skill', legacy.revision, {
        name: 'Legacy_Skill',
        description: 'Now described',
        instructions: 'Legacy instructions',
      })).rejects.toBeInstanceOf(AgentSkillValidationError);
      await expect(repo.update('Legacy_Skill', legacy.revision, {
        name: 'legacy-skill',
        description: '',
        instructions: 'Legacy instructions',
      })).rejects.toBeInstanceOf(AgentSkillValidationError);

      useMemoryRelocation();
      const renamed = await repo.update('Legacy_Skill', legacy.revision, {
        name: 'legacy-skill',
        description: 'Now described',
        instructions: 'Legacy instructions',
      });
      expect(renamed.frontmatter).toMatchObject({ 'allowed-tools': ['Read'] });
      expect(renamed.directoryPath).toBe(`${CLAUDE_SKILLS_ROOT}/legacy-skill`);
    });

    it('keeps strict reads for the default shared root', async () => {
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/no-frontmatter`);
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/no-frontmatter/SKILL.md`, 'Plain instructions\n');

      const result = await repository.list();

      expect(result.skills).toEqual([]);
      expect(result.diagnostics.map(item => item.directoryPath)).toEqual([
        `${AGENT_SKILLS_ROOT}/no-frontmatter`,
      ]);
    });
  });
  describe('repairing packages that need attention', () => {
    it('offers repair only for SKILL.md files with frontmatter that fail validation', async () => {
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/no-description`);
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/no-description/SKILL.md`, '---\nname: no-description\nlicense: MIT\n---\nKeep this\n');
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/Bad_Name`);
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\nname: Bad_Name\ndescription: Desc\n---\nBody\n');
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/no-frontmatter`);
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/no-frontmatter/SKILL.md`, 'Plain instructions\n');
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/empty`);

      const { diagnostics } = await repository.list();

      expect(diagnostics.map(item => [item.directoryPath, item.repairName])).toEqual([
        [`${AGENT_SKILLS_ROOT}/Bad_Name`, 'Bad_Name'],
        [`${AGENT_SKILLS_ROOT}/empty`, undefined],
        [`${AGENT_SKILLS_ROOT}/no-description`, 'no-description'],
        [`${AGENT_SKILLS_ROOT}/no-frontmatter`, undefined],
      ]);
      await expect(repository.readForRepair('no-description')).resolves.toMatchObject({
        input: { name: 'no-description', description: '', instructions: 'Keep this' },
        frontmatter: { license: 'MIT' },
      });
      await expect(repository.readForRepair('no-frontmatter')).rejects.toThrow('cannot be repaired');
      await expect(repository.readForRepair('empty')).rejects.toThrow('does not exist');
    });

    it('rewrites a flagged package as a valid skill, renaming its folder', async () => {
      useMemoryRelocation();
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/Bad_Name`);
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\nname: Bad_Name\ndescription: Desc\n---\nBody\n');
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/Bad_Name/asset.txt`, 'asset');

      const draft = await repository.readForRepair('Bad_Name');
      await repository.repair('Bad_Name', draft.revision, {
        name: 'fixed-skill', description: 'Now valid', instructions: 'Body',
      });

      const result = await repository.list();
      expect(result.diagnostics).toEqual([]);
      expect(result.skills.map(skill => [skill.name, skill.description])).toEqual([['fixed-skill', 'Now valid']]);
      expect(await dataAdapter.read(`${AGENT_SKILLS_ROOT}/fixed-skill/asset.txt`)).toBe('asset');
    });

    it('rejects a stale repair and invalid input', async () => {
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/broken`);
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, '---\nname: broken\n---\nOriginal\n');
      const draft = await repository.readForRepair('broken');
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, '---\nname: broken\n---\nChanged elsewhere\n');

      await expect(repository.repair('broken', draft.revision, {
        name: 'broken', description: 'Desc', instructions: 'Body',
      })).rejects.toBeInstanceOf(AgentSkillRevisionConflictError);
      const current = await repository.readForRepair('broken');
      await expect(repository.repair('broken', current.revision, {
        name: 'broken', description: '', instructions: 'Body',
      })).rejects.toBeInstanceOf(AgentSkillValidationError);
      expect(await dataAdapter.read(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`)).toContain('Changed elsewhere');
    });

    it('moves a broken package folder to trash', async () => {
      dataAdapter.addFolder(`${AGENT_SKILLS_ROOT}/broken`);
      dataAdapter.addFile(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, '---\nname: broken\n---\nBody\n');

      await repository.trashBroken('broken');

      expect(dataAdapter.trashed).toEqual([`${AGENT_SKILLS_ROOT}/broken`]);
    });
  });
  describe('on a filesystem-backed vault', () => {
    let vault: DesktopVault;

    beforeEach(async () => {
      vault = await DesktopVault.create();
    });

    afterEach(async () => {
      await vault.dispose();
    });

    it('renames a package folder while fixing it and leaves no empty folders behind', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/Weekly_Review/SKILL.md`, '---\nname: Weekly_Review\ndescription: Weekly\n---\nReview the week\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/Weekly_Review/notes.md`, 'extra');
      const desktop = new AgentSkillRepository(vault.files);

      const draft = await desktop.readForRepair('Weekly_Review');
      await desktop.repair('Weekly_Review', draft.revision, {
        name: 'weekly-review', description: 'Weekly', instructions: 'Review the week',
      });

      expect(await vault.exists(`${AGENT_SKILLS_ROOT}/Weekly_Review`)).toBe(false);
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/weekly-review/notes.md`)).toBe('extra');
      expect((await desktop.list()).skills.map(skill => skill.name)).toEqual(['weekly-review']);
    });

    it('still lists the other skills when the root holds a dangling link', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/kept/SKILL.md`, '---\nname: kept\ndescription: Kept\n---\nBody\n');
      await vault.symlink(`${AGENT_SKILLS_ROOT}/dangling`, vault.resolve('gone'));

      const result = await new AgentSkillRepository(vault.files).list();

      expect(result.skills.map(skill => skill.name)).toEqual(['kept']);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ directoryPath: `${AGENT_SKILLS_ROOT}/dangling` }),
      ]);
      expect(result.diagnostics[0].repairName).toBeUndefined();
    });
  });
});
