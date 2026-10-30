const actualModule0 = await vi.importActual<typeof fs>('node:fs/promises');
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parser } from '@lezer/markdown';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import * as obsidian from 'obsidian';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { AgentSkillManagementCoordinator } from '@/features/agent-skills/AgentSkillManagementCoordinator';
import {
  AGENT_SKILLS_ROOT,
  AgentSkillCollisionError,
  AgentSkillRepository,
  AgentSkillRevisionConflictError,
  CLAUDE_SKILLS_ROOT,
} from '@/features/agent-skills/AgentSkillRepository';
import { AgentSkillValidationError } from '@/features/agent-skills/validateAgentSkill';


vi.mock('node:fs/promises', async () => {
  const actual = (await vi.importActual<typeof fs>('node:fs/promises'));
  return { ...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile) };
});
const actualFs = actualModule0;

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
  let vault: DesktopVault;
  let vaultFiles: VaultFileAdapter;
  let repository: AgentSkillRepository;

  beforeEach(async () => {
    vault = await DesktopVault.create();
    await vault.mkdir(AGENT_SKILLS_ROOT);
    vaultFiles = vault.files;
    repository = new AgentSkillRepository(vaultFiles);
  });

  afterEach(async () => {
    vi.mocked(fs.mkdir).mockImplementation(actualFs.mkdir);
    vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
    await vault.dispose();
  });

  function addSkill(name: string, content = markdown(name)): Promise<void> {
    return vault.write(`${AGENT_SKILLS_ROOT}/${name}/SKILL.md`, content);
  }

  it.each(['strict', 'lenient'] as const)('reads and edits UTF-8 BOM skill documents under the %s policy', async readPolicy => {
    await addSkill('bom-skill', `\uFEFF${markdown('bom-skill')}`);
    const owner = new AgentSkillRepository(vaultFiles, { readPolicy });

    const initial = await owner.list();
    expect(initial.diagnostics).toEqual([]);
    expect(initial.skills).toHaveLength(1);
    const [loaded] = initial.skills;
    expect(loaded.instructions).toBe('Instructions');
    expect(loaded.frontmatter.license).toBe('MIT');

    await owner.update(loaded.name, loaded.revision, {
      name: loaded.name, description: 'Edited', instructions: 'Updated instructions',
    });
    const reloaded = await owner.list();
    expect(reloaded.diagnostics).toEqual([]);
    expect(reloaded.skills[0]).toMatchObject({
      description: 'Edited', instructions: 'Updated instructions', frontmatter: { license: 'MIT' },
    });
  });

  it.each(['strict', 'lenient'] as const)('keeps a leading Markdown code block through description edits under %s reading', async readPolicy => {
    const instructions = '    echo first\n    echo second';
    await addSkill('code-example', markdown('code-example', 'Original', `\n \n${instructions}\n\n`));
    const owner = new AgentSkillRepository(vaultFiles, { readPolicy });
    const [loaded] = (await owner.list()).skills;

    expect(parser.parse(loaded.instructions).topNode.firstChild?.name).toBe('CodeBlock');
    await owner.update(loaded.name, loaded.revision, { name: loaded.name, description: 'Changed description', instructions: loaded.instructions });
    const persisted = await vault.read(`${AGENT_SKILLS_ROOT}/code-example/SKILL.md`);
    expect(persisted).toContain(`---\n${instructions}\n`);
    const [reloaded] = (await owner.list()).skills;
    expect(reloaded.description).toBe('Changed description');
    expect(reloaded.instructions).toBe(instructions);
  });

  it('validates each skill file once through the safe reader', async () => {
    await addSkill('one'); await addSkill('two');
    const verify = vi.spyOn(vaultFiles, 'verifyManagedPath');
    const result = await repository.list();
    expect(result.skills).toHaveLength(2);
    expect(verify.mock.calls.filter(([file]) => file.endsWith('/SKILL.md'))).toHaveLength(2);
  });

  it('lists only direct packages and returns sorted skills and diagnostics', async () => {
    await addSkill('z-skill');
    await addSkill('a-skill');
    await vault.write(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, 'not frontmatter');
    await vault.mkdir(`${AGENT_SKILLS_ROOT}/missing`);
    await vault.write(`${AGENT_SKILLS_ROOT}/a-skill/nested/SKILL.md`, markdown('nested'));

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
      verifyManagedPath: vi.fn().mockRejectedValue(new Error('Managed resource must not be a symlink')),
    } as unknown as VaultFileAdapter;
    await expect(new AgentSkillRepository(rootUnsafeFiles).list()).rejects.toThrow('symlink');

    const childUnsafeFiles = {
      readManagedFile: vi.fn().mockRejectedValue(new Error('Managed resource must not be a symlink')),
      verifyManagedPath: vi.fn(async (candidate: string) => {
        if (candidate.endsWith('/unsafe')) throw new Error('Managed resource must not be a symlink');
        return true;
      }),
      listManagedFolderEntries: vi.fn().mockResolvedValue([
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
    expect(await vault.read(created.filePath)).toContain('portable-skill');

    await vault.mkdir(`${AGENT_SKILLS_ROOT}/orphan`);
    await expect(repository.create({
      name: 'orphan',
      description: 'Description',
      instructions: 'Instructions',
    })).rejects.toBeInstanceOf(AgentSkillCollisionError);
  });

  it.each(['con', 'com1'])('rejects reserved device package %s before changing the vault', async name => {
    const original = await vault.snapshot();
    await expect(repository.create({
      name, description: 'Description', instructions: 'Instructions',
    })).rejects.toBeInstanceOf(AgentSkillValidationError);
    expect(await vault.snapshot()).toEqual(original);
  });

  it('rejects a target created during the exclusive claim race', async () => {
    vi.mocked(fs.mkdir).mockImplementation(async (target, options) => {
      // Another writer claims the package between the existence check and the claim.
      if (target === vault.resolve(`${AGENT_SKILLS_ROOT}/racing`)) await actualFs.mkdir(target);
      return actualFs.mkdir(target, options);
    });

    await expect(repository.create({
      name: 'racing',
      description: 'Description',
      instructions: 'Instructions',
    })).rejects.toBeInstanceOf(AgentSkillCollisionError);
    expect(await vault.exists(`${AGENT_SKILLS_ROOT}/racing/SKILL.md`)).toBe(false);
  });

  it('updates owned fields while preserving unknown metadata and ancillary files', async () => {
    await addSkill('portable-skill');
    await vault.write(`${AGENT_SKILLS_ROOT}/portable-skill/script.ts`, 'export {};');
    const loaded = (await repository.list()).skills[0];

    const updated = await repository.update('portable-skill', loaded.revision, {
      name: 'portable-skill',
      description: 'Updated description',
      instructions: 'Updated instructions',
    });

    expect(updated.frontmatter).toMatchObject({ license: 'MIT', metadata: { owner: 'team' } });
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/portable-skill/script.ts`)).toBe('export {};');
  });

  it('rejects a stale update after an external edit', async () => {
    await addSkill('portable-skill');
    const loaded = (await repository.list()).skills[0];
    await vault.write(loaded.filePath, markdown('portable-skill', 'Externally changed'));

    await expect(repository.update('portable-skill', loaded.revision, {
      name: 'portable-skill',
      description: 'My edit',
      instructions: 'My instructions',
    })).rejects.toBeInstanceOf(AgentSkillRevisionConflictError);
  });

  it('renames the whole package and rejects a pre-existing empty destination', async () => {
    await addSkill('old-name');
    await vault.write(`${AGENT_SKILLS_ROOT}/old-name/assets/example.txt`, 'asset');
    const loaded = (await repository.list()).skills[0];

    const renamed = await repository.update('old-name', loaded.revision, {
      name: 'new-name',
      description: 'Updated',
      instructions: 'Updated instructions',
    });

    expect(renamed.directoryPath).toBe(`${AGENT_SKILLS_ROOT}/new-name`);
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/new-name/assets/example.txt`)).toBe('asset');
    expect(await vault.exists(`${AGENT_SKILLS_ROOT}/old-name`)).toBe(false);

    await addSkill('source-name');
    await vault.mkdir(`${AGENT_SKILLS_ROOT}/occupied`);
    const source = (await repository.list()).skills.find(skill => skill.name === 'source-name')!;
    await expect(repository.update('source-name', source.revision, {
      name: 'occupied',
      description: 'Description',
      instructions: 'Instructions',
    })).rejects.toBeInstanceOf(AgentSkillCollisionError);
  });

  it('restores the original package and content when the renamed write fails', async () => {
    await addSkill('old-name');
    await vault.write(`${AGENT_SKILLS_ROOT}/old-name/reference.txt`, 'reference');
    const loaded = (await repository.list()).skills[0];
    vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
      if (path.dirname(String(file)) === vault.resolve(`${AGENT_SKILLS_ROOT}/new-name`)) throw new Error('write failed');
      return actualFs.writeFile(file, data, options);
    });

    await expect(repository.update('old-name', loaded.revision, {
      name: 'new-name',
      description: 'Updated',
      instructions: 'Updated instructions',
    })).rejects.toThrow('Could not write managed resource');

    expect(await vault.read(`${AGENT_SKILLS_ROOT}/old-name/SKILL.md`)).toBe(markdown('old-name'));
    expect(await vault.read(`${AGENT_SKILLS_ROOT}/old-name/reference.txt`)).toBe('reference');
    expect(await vault.exists(`${AGENT_SKILLS_ROOT}/new-name`)).toBe(false);
  });

  it('rechecks the revision before trashing the whole validated package', async () => {
    await addSkill('portable-skill');
    await vault.write(`${AGENT_SKILLS_ROOT}/portable-skill/asset.txt`, 'asset');
    const loaded = (await repository.list()).skills[0];
    await vault.write(loaded.filePath, markdown('portable-skill', 'External edit'));

    await expect(repository.trash('portable-skill', loaded.revision))
      .rejects.toBeInstanceOf(AgentSkillRevisionConflictError);
    expect(vault.trashed).toEqual([]);

    const refreshed = (await repository.list()).skills[0];
    await repository.trash('portable-skill', refreshed.revision);
    expect(vault.trashed).toEqual([`${AGENT_SKILLS_ROOT}/portable-skill`]);
    expect(await vault.exists(`${AGENT_SKILLS_ROOT}/portable-skill/asset.txt`)).toBe(false);
  });

  it('serializes concurrent coordinator updates so only one loaded revision succeeds', async () => {
    await addSkill('portable-skill');
    const loaded = (await repository.list()).skills[0];

    const notify = vi.fn();
    const coordinator = new AgentSkillManagementCoordinator(repository, notify);
    const results = await Promise.allSettled([
      coordinator.update('portable-skill', loaded.revision, {
        name: 'portable-skill', description: 'First', instructions: 'First instructions',
      }),
      coordinator.update('portable-skill', loaded.revision, {
        name: 'portable-skill', description: 'Second', instructions: 'Second instructions',
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AgentSkillRevisionConflictError);
    expect(notify).toHaveBeenCalledTimes(1);
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
      expect(await vault.exists(`${AGENT_SKILLS_ROOT}/claude-skill`)).toBe(false);

      const updated = await repo.update('claude-skill', created.revision, {
        name: 'claude-skill',
        description: 'Updated',
        instructions: 'Updated instructions',
      });
      expect((await repo.list()).skills.map(skill => skill.description)).toEqual(['Updated']);

      await repo.trash('claude-skill', updated.revision);
      expect(vault.trashed).toEqual([`${CLAUDE_SKILLS_ROOT}/claude-skill`]);
    });

    it('removes unknown frontmatter on update under the portable policy', async () => {
      await addSkill('portable-skill');
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
      expect(await vault.read(updated.filePath)).not.toContain('license');
    });

    it('lists lenient packages without a matching name or description, but not files without frontmatter', async () => {
      await vault.write(
        `${CLAUDE_SKILLS_ROOT}/Legacy_Skill/SKILL.md`,
        '---\nallowed-tools: [Read]\n---\nLegacy instructions\n',
      );
      await vault.write(`${CLAUDE_SKILLS_ROOT}/no-frontmatter/SKILL.md`, 'Plain instructions\n');

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

      const renamed = await repo.update('Legacy_Skill', legacy.revision, {
        name: 'legacy-skill',
        description: 'Now described',
        instructions: 'Legacy instructions',
      });
      expect(renamed.frontmatter).toMatchObject({ 'allowed-tools': ['Read'] });
      expect(renamed.directoryPath).toBe(`${CLAUDE_SKILLS_ROOT}/legacy-skill`);
    });

    it('keeps strict reads for the default shared root', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/no-frontmatter/SKILL.md`, 'Plain instructions\n');

      const result = await repository.list();

      expect(result.skills).toEqual([]);
      expect(result.diagnostics.map(item => item.directoryPath)).toEqual([
        `${AGENT_SKILLS_ROOT}/no-frontmatter`,
      ]);
    });

    it('rejects a closing delimiter with trailing text in strict and lenient reads', async () => {
      const source = '---\nname: example\ndescription: Example\n---suffix\nPrompt';
      await addSkill('example', source);
      await vault.write(`${CLAUDE_SKILLS_ROOT}/example/SKILL.md`, source);

      const strict = await repository.list();
      expect(strict.skills).toEqual([]);
      expect(strict.diagnostics.map(item => [item.directoryPath, item.repairName])).toEqual([
        [`${AGENT_SKILLS_ROOT}/example`, undefined],
      ]);

      const lenient = await claudeRepository().list();
      expect(lenient.skills).toEqual([]);
      expect(lenient.diagnostics.map(item => [item.directoryPath, item.repairName])).toEqual([
        [`${CLAUDE_SKILLS_ROOT}/example`, undefined],
      ]);

      await expect(repository.readForRepair('example')).rejects.toThrow('cannot be repaired');
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/example/SKILL.md`)).toBe(source);
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/example/SKILL.md`)).toBe(source);
    });

    it('accepts a standalone closing delimiter after the same metadata', async () => {
      await addSkill('example', '---\nname: example\ndescription: Example\n---\nPrompt');

      const result = await repository.list();

      expect(result.diagnostics).toEqual([]);
      expect(result.skills.map(skill => [skill.name, skill.description, skill.instructions])).toEqual([
        ['example', 'Example', 'Prompt'],
      ]);
    });

    it.each<[string, unknown]>([
      ['undefined', undefined],
      ['null', null],
    ])('rejects an empty frontmatter document that external YAML parses as %s', async (_label, emptyDocument) => {
      const source = '---\n---\nBody';
      const parseYaml = obsidian.parseYaml;
      // Narrow spy: only empty YAML returns the external empty-document value;
      // every other input keeps the existing external parser.
      const parseYamlSpy = vi.spyOn(obsidian, 'parseYaml').mockImplementation(content => (
        content.trim() === '' ? emptyDocument as Record<string, unknown> : parseYaml(content)
      ));
      try {
        await addSkill('example', source);
        await vault.write(`${CLAUDE_SKILLS_ROOT}/example/SKILL.md`, source);

        const strict = await repository.list();
        expect(strict.skills).toEqual([]);
        expect(strict.diagnostics).toEqual([{
          directoryPath: `${AGENT_SKILLS_ROOT}/example`,
          message: 'SKILL.md frontmatter must be a YAML mapping',
        }]);

        const lenient = await claudeRepository().list();
        expect(lenient.skills).toEqual([]);
        expect(lenient.diagnostics).toEqual([{
          directoryPath: `${CLAUDE_SKILLS_ROOT}/example`,
          message: 'SKILL.md frontmatter must be a YAML mapping',
        }]);

        await expect(repository.readForRepair('example')).rejects.toThrow('cannot be repaired');
        await expect(claudeRepository().readForRepair('example')).rejects.toThrow('cannot be repaired');
        expect(await vault.read(`${AGENT_SKILLS_ROOT}/example/SKILL.md`)).toBe(source);
        expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/example/SKILL.md`)).toBe(source);
      } finally {
        parseYamlSpy.mockRestore();
      }
    });

    it.each<[string, string, string, [string, string, string][], [string, string, string | undefined][]]>([
      [
        'LF-space',
        '---\nname: example\ndescription: Example\n--- \nPrompt',
        'Prompt',
        [['example', 'Example', 'Prompt']],
        [],
      ],
      [
        'CRLF-tab',
        '---\r\nname: example\r\ndescription: Example\r\n---\t\r\nPrompt',
        'Prompt',
        [['example', 'Example', 'Prompt']],
        [],
      ],
      [
        'padded-EOF',
        '---\nname: example\ndescription: Example\n--- \t',
        '',
        [],
        [[`${AGENT_SKILLS_ROOT}/example`, 'Skill instructions are required', 'example']],
      ],
    ])('reads skills through a padded closing delimiter (%s)', async (
      _label,
      source,
      instructions,
      strictSkills,
      strictDiagnostics,
    ) => {
      await addSkill('example', source);
      await vault.write(`${CLAUDE_SKILLS_ROOT}/example/SKILL.md`, source);

      const strict = await repository.list();
      expect(strict.skills.map(skill => [skill.name, skill.description, skill.instructions])).toEqual(strictSkills);
      expect(strict.diagnostics.map(item => [item.directoryPath, item.message, item.repairName]))
        .toEqual(strictDiagnostics);

      const lenient = await claudeRepository().list();
      expect(lenient.skills.map(skill => [skill.name, skill.description, skill.instructions])).toEqual([
        ['example', 'Example', instructions],
      ]);
      expect(lenient.diagnostics).toEqual([]);

      await expect(repository.readForRepair('example')).resolves.toMatchObject({
        input: { name: 'example', description: 'Example', instructions },
      });

      expect(await vault.read(`${AGENT_SKILLS_ROOT}/example/SKILL.md`)).toBe(source);
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/example/SKILL.md`)).toBe(source);
    });
  });
  describe('repairing packages that need attention', () => {
    it('offers repair only for SKILL.md files with frontmatter that fail validation', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/no-description/SKILL.md`, '---\nname: no-description\nlicense: MIT\n---\nKeep this\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\nname: Bad_Name\ndescription: Desc\n---\nBody\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/no-frontmatter/SKILL.md`, 'Plain instructions\n');
      await vault.mkdir(`${AGENT_SKILLS_ROOT}/empty`);

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
      await vault.write(`${AGENT_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\nname: Bad_Name\ndescription: Desc\n---\nBody\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/Bad_Name/asset.txt`, 'asset');

      const draft = await repository.readForRepair('Bad_Name');
      await repository.repair('Bad_Name', draft.revision, {
        name: 'fixed-skill', description: 'Now valid', instructions: 'Body',
      });

      const result = await repository.list();
      expect(result.diagnostics).toEqual([]);
      expect(result.skills.map(skill => [skill.name, skill.description])).toEqual([['fixed-skill', 'Now valid']]);
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/fixed-skill/asset.txt`)).toBe('asset');
    });

    it('rejects a stale repair and invalid input', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, '---\nname: broken\n---\nOriginal\n');
      const draft = await repository.readForRepair('broken');
      await vault.write(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, '---\nname: broken\n---\nChanged elsewhere\n');

      await expect(repository.repair('broken', draft.revision, {
        name: 'broken', description: 'Desc', instructions: 'Body',
      })).rejects.toBeInstanceOf(AgentSkillRevisionConflictError);
      const current = await repository.readForRepair('broken');
      await expect(repository.repair('broken', current.revision, {
        name: 'broken', description: '', instructions: 'Body',
      })).rejects.toBeInstanceOf(AgentSkillValidationError);
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`)).toContain('Changed elsewhere');
    });

    it('moves a broken package folder to trash', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/broken/SKILL.md`, '---\nname: broken\n---\nBody\n');

      const [diagnostic] = (await repository.list()).diagnostics;
      expect(diagnostic.repairRevision).toBe((await repository.readForRepair('broken')).revision);
      await repository.trashBroken('broken', diagnostic.repairRevision!);

      expect(vault.trashed).toEqual([`${AGENT_SKILLS_ROOT}/broken`]);
    });
  });
  describe('on a filesystem-backed vault', () => {
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
