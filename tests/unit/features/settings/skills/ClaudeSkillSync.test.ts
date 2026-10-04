import { readdir } from 'node:fs/promises';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { clearWriteFaults, failWritesUnder } from '@test/helpers/core/fsWriteFaults';

import { AGENT_SKILLS_ROOT, CLAUDE_COMMANDS_ROOT, CLAUDE_SKILLS_ROOT } from '@/features/settings/skills/AgentSkillRepository';
import {
  ClaudeSkillSync,
  SkillSyncBlockedError,
  type SkillSyncItem,
  type SkillSyncResolution,
  SkillSyncStaleError,
} from '@/features/settings/skills/ClaudeSkillSync';

// Obsidian's parseYaml rejects invalid YAML; the shared mock does not.
jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  parseYaml: (source: string) => jest.requireActual('js-yaml').load(source),
}));

jest.mock('node:fs/promises', () => (
  jest.requireActual('@test/helpers/core/fsWriteFaults').createFsPromisesWithWriteFaults()
));

function skill(name: string, description = 'Description', body = 'Instructions', extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
}

function frontmatterKeys(content: string): string[] {
  const block = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  return block.split('\n').map(line => line.split(':')[0]).filter(Boolean);
}

describe('ClaudeSkillSync', () => {
  let vault: DesktopVault;
  let sync: ClaudeSkillSync;

  beforeEach(async () => {
    vault = await DesktopVault.create();
    sync = new ClaudeSkillSync(vault.files);
  });

  afterEach(async () => {
    clearWriteFaults();
    await vault.dispose();
  });

  function item(items: SkillSyncItem[], id: string): SkillSyncItem {
    const found = items.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Missing plan item ${id}`);
    return found;
  }

  const resolutions = (entries: Array<[string, SkillSyncResolution]> = []) => new Map(entries);

  describe('link states', () => {
    it('links a missing folder without planning items', async () => {
      const plan = await sync.plan();
      expect(plan).toEqual({ state: 'missing', items: [], sharedNames: [] });

      const result = await sync.execute(plan, resolutions());

      expect(result.linked).toBe(true);
      expect(await vault.readlink(CLAUDE_SKILLS_ROOT)).toBe('../.agents/skills');
      await expect(sync.readState()).resolves.toBe('linked');
    });

    it('converts existing commands before linking when .claude/skills is missing', async () => {
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy.md`, '---\ndescription: Deploy\nargument-hint: x\n---\nDeploy it\n');

      const plan = await sync.plan();
      expect(plan.state).toBe('missing');
      expect(plan.items.map(entry => [entry.kind, entry.proposedName])).toEqual([['command', 'deploy']]);
      const result = await sync.execute(plan, resolutions());

      expect(result).toMatchObject({ linked: true, converted: [`${CLAUDE_COMMANDS_ROOT}/deploy.md`], failed: [] });
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/deploy/SKILL.md`)).not.toContain('argument-hint');
      expect(await vault.exists(CLAUDE_COMMANDS_ROOT)).toBe(false);
      await expect(sync.readState()).resolves.toBe('linked');
    });

    it('reports an existing link as synced and does nothing on a second run', async () => {
      await sync.execute(await sync.plan(), resolutions());
      await vault.write(`${AGENT_SKILLS_ROOT}/kept/SKILL.md`, skill('kept'));

      const plan = await sync.plan();
      const result = await sync.execute(plan, resolutions());

      expect(plan.state).toBe('linked');
      expect(result).toMatchObject({ linked: true, moved: [], trashed: [] });
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/kept/SKILL.md`)).toBe(skill('kept'));
    });

    it.each([
      ['foreign-link', 'elsewhere'],
      ['broken-link', 'gone'],
    ] as const)('repairs a %s without touching the old target', async (state, targetName) => {
      await vault.write('elsewhere/keep.txt', 'keep');
      await vault.mkdir('.claude');
      await vault.symlink(CLAUDE_SKILLS_ROOT, vault.resolve(targetName));

      const plan = await sync.plan();
      expect(plan.state).toBe(state);
      await sync.execute(plan, resolutions());

      await expect(sync.readState()).resolves.toBe('linked');
      expect(await vault.read('elsewhere/keep.txt')).toBe('keep');
    });

    it('rejects a stale plan when the link state changed', async () => {
      const plan = await sync.plan();
      await vault.mkdir(CLAUDE_SKILLS_ROOT);

      await expect(sync.execute(plan, resolutions())).rejects.toBeInstanceOf(SkillSyncStaleError);
    });
  });

  describe('planning a Claude skills folder', () => {
    it('plans packages, commands, links and leftovers with their issues', async () => {
      await vault.write(
        `${CLAUDE_SKILLS_ROOT}/review/SKILL.md`,
        skill('review', 'Review code', 'Review $ARGUMENTS and !`git diff` with @src/main.ts', 'allowed-tools: [Read]\n'),
      );
      await vault.write(`${CLAUDE_SKILLS_ROOT}/review/scripts/run.sh`, 'echo run');
      await vault.write(`${CLAUDE_SKILLS_ROOT}/README.md`, 'stray');
      await vault.mkdir(`${CLAUDE_SKILLS_ROOT}/empty-folder`);
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/git/Commit.md`, '---\nargument-hint: "[msg]"\n---\nCommit $1\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/linked/SKILL.md`, skill('linked'));
      await vault.symlink(`${CLAUDE_SKILLS_ROOT}/linked`, vault.resolve(`${AGENT_SKILLS_ROOT}/linked`));

      const plan = await sync.plan();

      expect(plan.state).toBe('folder');
      expect(plan.items.map(entry => [entry.id, entry.kind, entry.proposedName])).toEqual([
        [`${CLAUDE_SKILLS_ROOT}/empty-folder`, 'leftover', ''],
        [`${CLAUDE_SKILLS_ROOT}/linked`, 'link', 'linked'],
        [`${CLAUDE_SKILLS_ROOT}/README.md`, 'leftover', ''],
        [`${CLAUDE_SKILLS_ROOT}/review`, 'package', 'review'],
        [`${CLAUDE_COMMANDS_ROOT}/git/Commit.md`, 'command', 'git-commit'],
      ]);
      expect(item(plan.items, `${CLAUDE_SKILLS_ROOT}/review`).issues).toEqual([
        { code: 'dropped-frontmatter', keys: ['allowed-tools'] },
        { code: 'claude-syntax', matches: ['$ARGUMENTS', '!`git diff`', '@src/main.ts'] },
        { code: 'extra-files', count: 1 },
      ]);
      expect(item(plan.items, `${CLAUDE_COMMANDS_ROOT}/git/Commit.md`).issues).toEqual([
        { code: 'dropped-frontmatter', keys: ['argument-hint'] },
        { code: 'claude-syntax', matches: ['$1'] },
      ]);
    });

    it('treats folders whose SKILL.md is missing or has no frontmatter as other files', async () => {
      await vault.write(`${CLAUDE_SKILLS_ROOT}/plain/SKILL.md`, 'No frontmatter\n');
      await vault.mkdir(`${CLAUDE_SKILLS_ROOT}/empty`);

      const plan = await sync.plan();

      expect(plan.items.map(entry => [entry.id, entry.kind])).toEqual([
        [`${CLAUDE_SKILLS_ROOT}/empty`, 'leftover'],
        [`${CLAUDE_SKILLS_ROOT}/plain`, 'leftover'],
      ]);
      expect(sync.getBlockingReasons(plan, resolutions()).size).toBe(0);
      const result = await sync.execute(plan, resolutions());
      expect(result).toMatchObject({ linked: true, moved: [], failed: [] });
      expect(vault.trashed).toEqual(expect.arrayContaining([
        `${CLAUDE_SKILLS_ROOT}/empty`,
        `${CLAUDE_SKILLS_ROOT}/plain`,
      ]));
    });

    it('auto-resolves byte-identical copies but not packages with one differing file', async () => {
      for (const root of [CLAUDE_SKILLS_ROOT, AGENT_SKILLS_ROOT]) {
        await vault.write(`${root}/same/SKILL.md`, skill('same'));
        await vault.write(`${root}/same/ref.md`, 'reference');
        await vault.write(`${root}/differs/SKILL.md`, skill('differs'));
      }
      await vault.write(`${CLAUDE_SKILLS_ROOT}/differs/ref.md`, 'only in claude');

      const plan = await sync.plan();

      expect(item(plan.items, `${CLAUDE_SKILLS_ROOT}/same`).issues).toContainEqual({ code: 'already-shared' });
      expect(item(plan.items, `${CLAUDE_SKILLS_ROOT}/differs`).issues).not.toContainEqual({ code: 'already-shared' });
      expect([...sync.getBlockingReasons(plan, resolutions()).entries()]).toEqual([
        [`${CLAUDE_SKILLS_ROOT}/differs`, [{ code: 'name-conflict', with: 'shared', name: 'differs' }]],
      ]);
    });

    it('unlinks a dangling per-skill link that listing cannot follow', async () => {
      await vault.write(`${CLAUDE_SKILLS_ROOT}/real/SKILL.md`, skill('real'));
      await vault.symlink(`${CLAUDE_SKILLS_ROOT}/dangling`, vault.resolve('gone'));

      const plan = await sync.plan();
      expect(plan.items.map(entry => [entry.id, entry.kind])).toEqual([
        [`${CLAUDE_SKILLS_ROOT}/dangling`, 'link'],
        [`${CLAUDE_SKILLS_ROOT}/real`, 'package'],
      ]);
      const result = await sync.execute(plan, resolutions());

      expect(result).toMatchObject({ linked: true, unlinked: [`${CLAUDE_SKILLS_ROOT}/dangling`], failed: [] });
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/real/SKILL.md`)).toContain('Instructions');
    });

    it('asks before discarding a package whose frontmatter cannot be parsed', async () => {
      const raw = '---\nname: broken\ndescription: Use when: reviewing\n---\nBody\n';
      await vault.write(`${CLAUDE_SKILLS_ROOT}/broken/SKILL.md`, raw);

      const plan = await sync.plan();
      expect(item(plan.items, `${CLAUDE_SKILLS_ROOT}/broken`).kind).toBe('unreadable');
      expect(sync.getBlockingReasons(plan, resolutions()).get(`${CLAUDE_SKILLS_ROOT}/broken`)).toEqual([
        expect.objectContaining({ code: 'unreadable' }),
      ]);
      await expect(sync.execute(plan, resolutions())).rejects.toBeInstanceOf(SkillSyncBlockedError);
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/broken/SKILL.md`)).toBe(raw);

      const result = await sync.execute(plan, resolutions([[`${CLAUDE_SKILLS_ROOT}/broken`, { action: 'skip' }]]));
      expect(result).toMatchObject({ linked: true, trashed: [`${CLAUDE_SKILLS_ROOT}/broken`] });
    });

    it('refuses to plan when .claude/skills is a file', async () => {
      await vault.write(CLAUDE_SKILLS_ROOT, 'not a folder');

      await expect(sync.plan()).rejects.toThrow(/is a file/);
    });
  });

  it('compares package files byte for byte before discarding a copy', async () => {
    for (const root of [CLAUDE_SKILLS_ROOT, AGENT_SKILLS_ROOT]) {
      await vault.write(`${root}/icons/SKILL.md`, skill('icons'));
    }
    // Both byte sequences are invalid UTF-8 and decode to the same replacement character.
    await vault.writeBytes(`${CLAUDE_SKILLS_ROOT}/icons/logo.bin`, Uint8Array.of(0xff));
    await vault.writeBytes(`${AGENT_SKILLS_ROOT}/icons/logo.bin`, Uint8Array.of(0xfe));

    const plan = await sync.plan();

    expect(item(plan.items, `${CLAUDE_SKILLS_ROOT}/icons`).issues).not.toContainEqual({ code: 'already-shared' });
  });

  describe('blocking reasons', () => {
    it('reports every invalid field of an item at once', async () => {
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/Bad_Name.md`, '');

      const plan = await sync.plan();

      expect(sync.getBlockingReasons(plan, resolutions()).get(`${CLAUDE_COMMANDS_ROOT}/Bad_Name.md`)).toEqual([
        expect.objectContaining({ code: 'invalid', field: 'name' }),
        expect.objectContaining({ code: 'invalid', field: 'description' }),
        expect.objectContaining({ code: 'invalid', field: 'instructions' }),
      ]);
    });

    it('blocks invalid names, missing descriptions and case-insensitive conflicts until resolved', async () => {
      await vault.write(`${CLAUDE_SKILLS_ROOT}/Bad_Name/SKILL.md`, '---\ndescription: Bad\n---\nBody\n');
      await vault.write(`${CLAUDE_SKILLS_ROOT}/no-desc/SKILL.md`, '---\nname: no-desc\n---\nBody only\n');
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/Deploy.md`, '---\ndescription: Deploy\n---\nDeploy it\n');
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/deploy/README.md`, '---\ndescription: Nested\n---\nBody\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/shared/SKILL.md`, skill('shared'));
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/shared.md`, '---\ndescription: Clash\n---\nBody\n');

      const plan = await sync.plan();
      const blocking = sync.getBlockingReasons(plan, resolutions());

      expect(blocking.get(`${CLAUDE_SKILLS_ROOT}/Bad_Name`)).toEqual([
        expect.objectContaining({ code: 'invalid', field: 'name' }),
      ]);
      expect(blocking.get(`${CLAUDE_SKILLS_ROOT}/no-desc`)).toEqual([
        expect.objectContaining({ code: 'invalid', field: 'description' }),
      ]);
      expect(blocking.get(`${CLAUDE_COMMANDS_ROOT}/shared.md`)).toEqual([
        { code: 'name-conflict', with: 'shared', name: 'shared' },
      ]);
      expect(blocking.has(`${CLAUDE_COMMANDS_ROOT}/Deploy.md`)).toBe(false);
      expect(blocking.has(`${CLAUDE_COMMANDS_ROOT}/deploy/README.md`)).toBe(false);

      const renamed = sync.getBlockingReasons(plan, resolutions([
        [`${CLAUDE_SKILLS_ROOT}/Bad_Name`, { action: 'apply', name: 'deploy' }],
        [`${CLAUDE_SKILLS_ROOT}/no-desc`, { action: 'apply', description: 'Now described' }],
        [`${CLAUDE_COMMANDS_ROOT}/shared.md`, { action: 'apply', replaceExisting: true }],
      ]));
      expect([...renamed.entries()]).toEqual([
        [`${CLAUDE_SKILLS_ROOT}/Bad_Name`, [{ code: 'name-conflict', with: 'item', name: 'deploy' }]],
        [`${CLAUDE_COMMANDS_ROOT}/Deploy.md`, [{ code: 'name-conflict', with: 'item', name: 'deploy' }]],
      ]);
      await expect(sync.execute(plan, resolutions())).rejects.toBeInstanceOf(SkillSyncBlockedError);
      expect(await vault.exists(`${CLAUDE_SKILLS_ROOT}/Bad_Name/SKILL.md`)).toBe(true);
    });
  });

  describe('executing a folder sync', () => {
    it('moves packages intact, converts commands, strips frontmatter and links the folder', async () => {
      await vault.write(
        `${CLAUDE_SKILLS_ROOT}/review/SKILL.md`,
        skill('review', 'Review code', 'Review carefully', 'allowed-tools: [Read]\nmodel: opus\n'),
      );
      await vault.write(`${CLAUDE_SKILLS_ROOT}/review/scripts/run.sh`, 'echo run');
      await vault.write(`${CLAUDE_SKILLS_ROOT}/README.md`, 'stray');
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/git/commit.md`, '---\ndescription: Commit\nargument-hint: x\n---\nCommit now\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/linked/SKILL.md`, skill('linked'));
      await vault.symlink(`${CLAUDE_SKILLS_ROOT}/linked`, vault.resolve(`${AGENT_SKILLS_ROOT}/linked`));

      const result = await sync.execute(await sync.plan(), resolutions());

      expect(result).toMatchObject({
        linked: true,
        moved: [`${CLAUDE_SKILLS_ROOT}/review`],
        converted: [`${CLAUDE_COMMANDS_ROOT}/git/commit.md`],
        trashed: [`${CLAUDE_SKILLS_ROOT}/README.md`],
        unlinked: [`${CLAUDE_SKILLS_ROOT}/linked`],
        failed: [],
      });
      const moved = await vault.read(`${AGENT_SKILLS_ROOT}/review/SKILL.md`);
      expect(frontmatterKeys(moved)).toEqual(['name', 'description']);
      expect(moved).toContain('Review carefully');
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/review/scripts/run.sh`)).toBe('echo run');
      const converted = await vault.read(`${AGENT_SKILLS_ROOT}/git-commit/SKILL.md`);
      expect(frontmatterKeys(converted)).toEqual(['name', 'description']);
      expect(converted).toContain('Commit now');
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/linked/SKILL.md`)).toBe(skill('linked'));
      expect(await vault.exists(CLAUDE_COMMANDS_ROOT)).toBe(false);
      expect(vault.trashed).toEqual(expect.arrayContaining([
        `${CLAUDE_SKILLS_ROOT}/README.md`,
        `${CLAUDE_COMMANDS_ROOT}/git/commit.md`,
      ]));
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/review/scripts/run.sh`)).toBe('echo run');
    });

    it('never follows a foreign per-skill link when removing it', async () => {
      await vault.write('outside/keep/SKILL.md', skill('keep'));
      await vault.symlink(`${CLAUDE_SKILLS_ROOT}/keep`, vault.resolve('outside/keep'));

      const plan = await sync.plan();
      expect(item(plan.items, `${CLAUDE_SKILLS_ROOT}/keep`)).toMatchObject({ kind: 'link', proposedName: '' });
      await sync.execute(plan, resolutions());

      expect(await vault.read('outside/keep/SKILL.md')).toBe(skill('keep'));
      await expect(sync.readState()).resolves.toBe('linked');
    });

    it('keeps the original package intact when every write to the target fails midway', async () => {
      const original = skill('fails', 'Original', 'Original instructions', 'model: opus\n');
      await vault.write(`${CLAUDE_SKILLS_ROOT}/fails/SKILL.md`, original);
      const plan = await sync.plan();
      failWritesUnder(vault.resolve(`${AGENT_SKILLS_ROOT}/fails`), '---\nname: fa');

      const result = await sync.execute(plan, resolutions());

      expect(result.failed.map(entry => entry.id)).toEqual([`${CLAUDE_SKILLS_ROOT}/fails`]);
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/fails/SKILL.md`)).toBe(original);
      expect(await readdir(vault.resolve(`${CLAUDE_SKILLS_ROOT}/fails`))).toEqual(['SKILL.md']);
      expect(await vault.exists(`${AGENT_SKILLS_ROOT}/fails`)).toBe(false);
    });

    it('replaces a shared package whose folder differs only by case', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/Demo/SKILL.md`, '---\nname: Demo\ndescription: Old\n---\nOld\n');
      await vault.write(`${CLAUDE_SKILLS_ROOT}/demo/SKILL.md`, skill('demo', 'New'));
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/Other.md`, '---\ndescription: Command\n---\nBody\n');
      await vault.write(`${AGENT_SKILLS_ROOT}/OTHER/SKILL.md`, '---\nname: OTHER\ndescription: Old\n---\nOld\n');

      const plan = await sync.plan();
      expect(sync.getBlockingReasons(plan, resolutions()).size).toBe(2);
      const result = await sync.execute(plan, resolutions([
        [`${CLAUDE_SKILLS_ROOT}/demo`, { action: 'apply', replaceExisting: true }],
        [`${CLAUDE_COMMANDS_ROOT}/Other.md`, { action: 'apply', replaceExisting: true }],
      ]));

      expect(result.failed).toEqual([]);
      expect(vault.trashed).toEqual(expect.arrayContaining([`${AGENT_SKILLS_ROOT}/Demo`, `${AGENT_SKILLS_ROOT}/OTHER`]));
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/demo/SKILL.md`)).toContain('New');
    });

    it('applies renames, descriptions, replacements and skips', async () => {
      await vault.write(`${AGENT_SKILLS_ROOT}/shared/SKILL.md`, skill('shared', 'Old'));
      await vault.write(`${CLAUDE_SKILLS_ROOT}/shared/SKILL.md`, skill('shared', 'New'));
      await vault.write(`${CLAUDE_SKILLS_ROOT}/Legacy/SKILL.md`, '---\nname: Legacy\n---\nLegacy body\n');
      await vault.write(`${CLAUDE_SKILLS_ROOT}/unwanted/SKILL.md`, skill('unwanted'));
      await vault.write(`${CLAUDE_COMMANDS_ROOT}/keep-me.md`, 'Command body\n');

      const plan = await sync.plan();
      const result = await sync.execute(plan, resolutions([
        [`${CLAUDE_SKILLS_ROOT}/shared`, { action: 'apply', replaceExisting: true }],
        [`${CLAUDE_SKILLS_ROOT}/Legacy`, { action: 'apply', name: 'legacy', description: 'Legacy skill' }],
        [`${CLAUDE_SKILLS_ROOT}/unwanted`, { action: 'skip' }],
        [`${CLAUDE_COMMANDS_ROOT}/keep-me.md`, { action: 'skip' }],
      ]));

      expect(result.failed).toEqual([]);
      expect(result.linked).toBe(true);
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/shared/SKILL.md`)).toContain('New');
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/legacy/SKILL.md`)).toContain('Legacy skill');
      expect(await vault.exists(`${AGENT_SKILLS_ROOT}/unwanted`)).toBe(false);
      expect(vault.trashed).toEqual(expect.arrayContaining([
        `${AGENT_SKILLS_ROOT}/shared`,
        `${CLAUDE_SKILLS_ROOT}/unwanted`,
      ]));
      expect(await vault.exists(`${CLAUDE_COMMANDS_ROOT}/keep-me.md`)).toBe(true);
      expect(await vault.read(`${CLAUDE_COMMANDS_ROOT}/keep-me.md`)).toBe('Command body\n');
    });

    it('keeps a copy that stopped matching its shared skill after the preview', async () => {
      for (const root of [CLAUDE_SKILLS_ROOT, AGENT_SKILLS_ROOT]) {
        await vault.write(`${root}/same/SKILL.md`, skill('same'));
        await vault.write(`${root}/same/ref.md`, 'reference');
      }
      const plan = await sync.plan();
      expect(item(plan.items, `${CLAUDE_SKILLS_ROOT}/same`).issues).toContainEqual({ code: 'already-shared' });
      await vault.write(`${CLAUDE_SKILLS_ROOT}/same/ref.md`, 'edited after preview');

      const result = await sync.execute(plan, resolutions());

      expect(result.linked).toBe(false);
      expect(result.failed.map(entry => entry.id)).toEqual([`${CLAUDE_SKILLS_ROOT}/same`]);
      expect(vault.trashed).toEqual([]);
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/same/ref.md`)).toBe('edited after preview');
    });

    it('does not link when an item changed or failed, and a re-run completes', async () => {
      await vault.write(`${CLAUDE_SKILLS_ROOT}/changes/SKILL.md`, skill('changes'));
      await vault.write(`${CLAUDE_SKILLS_ROOT}/fails/SKILL.md`, skill('fails'));
      await vault.write(`${CLAUDE_SKILLS_ROOT}/moves/SKILL.md`, skill('moves'));

      const plan = await sync.plan();
      await vault.write(`${CLAUDE_SKILLS_ROOT}/changes/SKILL.md`, skill('changes', 'Edited after preview'));
      failWritesUnder(vault.resolve(`${AGENT_SKILLS_ROOT}/fails`));
      const first = await sync.execute(plan, resolutions());

      expect(first.linked).toBe(false);
      expect(first.failed.map(entry => entry.id)).toEqual([
        `${CLAUDE_SKILLS_ROOT}/changes`,
        `${CLAUDE_SKILLS_ROOT}/fails`,
      ]);
      expect(first.moved).toEqual([`${CLAUDE_SKILLS_ROOT}/moves`]);
      await expect(sync.readState()).resolves.toBe('folder');
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/changes/SKILL.md`)).toContain('Edited after preview');
      expect(await vault.read(`${CLAUDE_SKILLS_ROOT}/fails/SKILL.md`)).toBe(skill('fails'));
      expect(await vault.exists(`${AGENT_SKILLS_ROOT}/fails`)).toBe(false);

      clearWriteFaults();
      const retryPlan = await sync.plan();
      expect(retryPlan.items.map(entry => entry.id)).toEqual([
        `${CLAUDE_SKILLS_ROOT}/changes`,
        `${CLAUDE_SKILLS_ROOT}/fails`,
      ]);
      const retry = await sync.execute(retryPlan, resolutions());

      expect(retry.failed).toEqual([]);
      expect(retry.linked).toBe(true);
      expect(await vault.read(`${AGENT_SKILLS_ROOT}/changes/SKILL.md`)).toContain('Edited after preview');
    });
  });
});
