import { MemoryDataAdapter } from '@test/helpers/MemoryDataAdapter';
import type { App } from 'obsidian';

import {
  AGENT_SKILLS_ROOT,
  AgentSkillCollisionError,
  AgentSkillRepository,
  AgentSkillRevisionConflictError,
} from '@/core/skills/AgentSkillRepository';
import {
  ManagedResourceCollisionError,
  VaultFileAdapter,
} from '@/core/storage/VaultFileAdapter';

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
      verifyManagedPath: jest.fn(async (candidate: string) => {
        if (candidate.endsWith('/unsafe')) throw new Error('Managed resource must not be a symlink');
        return true;
      }),
      listManagedFolder: jest.fn().mockResolvedValue({
        files: [],
        folders: [`${AGENT_SKILLS_ROOT}/unsafe`],
      }),
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
    })).rejects.toThrow('Could not rename skill');

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
});
