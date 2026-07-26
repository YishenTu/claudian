import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  KIMI_BRAND_AGENTS_PATH,
  KIMI_GENERIC_AGENTS_PATH,
  type KimiAgentDefinition,
  KimiAgentStorage,
  parseKimiAgentMarkdown,
  serializeKimiAgentMarkdown,
  validateKimiAgentName,
} from '@/providers/kimi/agents/KimiAgentStorage';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return {
    exists: jest.fn(async (targetPath: string) =>
      targetPath in files || Object.keys(files).some((key) => key.startsWith(`${targetPath}/`)),
    ),
    read: jest.fn(async (targetPath: string) => {
      if (!(targetPath in files)) {
        throw new Error(`File not found: ${targetPath}`);
      }
      return files[targetPath];
    }),
    write: jest.fn(async (targetPath: string, content: string) => {
      files[targetPath] = content;
    }),
    delete: jest.fn(async (targetPath: string) => {
      delete files[targetPath];
    }),
    listFilesRecursive: jest.fn(async (folder: string) => {
      const prefix = folder.endsWith('/') ? folder : `${folder}/`;
      return Object.keys(files).filter((key) => key.startsWith(prefix));
    }),
  } as unknown as VaultFileAdapter;
}

const REVIEWER_MARKDOWN = `---
name: code-reviewer
description: "Reviews code for correctness."
tools: [read, grep]
---
Review code like an owner.
`;

const NAME_FROM_FILE_MARKDOWN = `---
description: "Audits vault notes."
---
Audit every note carefully.
`;

const FULL_MARKDOWN = `---
name: deep-reviewer
description: "Reviews code deeply."
override: true
whenToUse: "Use for deep audits."
tools:
  - read
  - grep
disallowedTools: write, edit
subagents:
  - helper
model_preference: secondary
custom_unknown: "keep me"
---
Review deeply and call out regressions.
`;

function makeAgent(overrides: Partial<KimiAgentDefinition> = {}): KimiAgentDefinition {
  return {
    description: 'Reviews code.',
    filePath: `${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`,
    name: 'code-reviewer',
    prompt: 'Review carefully.',
    ...overrides,
  };
}

describe('validateKimiAgentName', () => {
  it('accepts kebab-case names and rejects everything kimi rejects', () => {
    expect(validateKimiAgentName('code-reviewer')).toBeNull();
    expect(validateKimiAgentName('a1')).toBeNull();
    expect(validateKimiAgentName('')).toBeTruthy();
    expect(validateKimiAgentName('Code-Reviewer')).toBeTruthy();
    expect(validateKimiAgentName('-lead')).toBeTruthy();
    expect(validateKimiAgentName('trail-')).toBeTruthy();
    expect(validateKimiAgentName('double--hyphen')).toBeTruthy();
    expect(validateKimiAgentName('under_score')).toBeTruthy();
    expect(validateKimiAgentName('has space')).toBeTruthy();
  });
});

describe('parseKimiAgentMarkdown', () => {
  it('parses the kimi agent file format', () => {
    const agent = parseKimiAgentMarkdown(REVIEWER_MARKDOWN, `${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`);

    expect(agent).toEqual({
      description: 'Reviews code for correctness.',
      filePath: `${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`,
      name: 'code-reviewer',
      prompt: 'Review code like an owner.',
      tools: ['read', 'grep'],
    });
  });

  it('falls back to the file name when frontmatter omits name', () => {
    const agent = parseKimiAgentMarkdown(
      NAME_FROM_FILE_MARKDOWN,
      `${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`,
    );

    expect(agent?.name).toBe('note-auditor');
  });

  it('parses managed fields and preserves unmanaged frontmatter', () => {
    const agent = parseKimiAgentMarkdown(FULL_MARKDOWN, `${KIMI_BRAND_AGENTS_PATH}/deep-reviewer.md`);

    expect(agent).toEqual({
      description: 'Reviews code deeply.',
      disallowedTools: ['write', 'edit'],
      extraFrontmatter: {
        custom_unknown: 'keep me',
        override: true,
        subagents: ['helper'],
        whenToUse: 'Use for deep audits.',
      },
      filePath: `${KIMI_BRAND_AGENTS_PATH}/deep-reviewer.md`,
      modelPreference: 'secondary',
      name: 'deep-reviewer',
      prompt: 'Review deeply and call out regressions.',
      tools: ['read', 'grep'],
    });
  });

  it('treats a lone * tools list as unrestricted', () => {
    const agent = parseKimiAgentMarkdown(
      '---\nname: free-agent\ndescription: "d"\ntools: ["*"]\n---\nbody\n',
      `${KIMI_BRAND_AGENTS_PATH}/free-agent.md`,
    );

    expect(agent?.tools).toBeUndefined();
  });

  it('rejects files kimi itself would refuse to load', () => {
    const path = `${KIMI_BRAND_AGENTS_PATH}/agent.md`;

    expect(parseKimiAgentMarkdown('no frontmatter at all', path)).toBeNull();
    expect(parseKimiAgentMarkdown('---\nname: ok\n---\nbody\n', path)).toBeNull();
    expect(parseKimiAgentMarkdown(`---\ndescription: "d"\n---\n   \n`, path)).toBeNull();
    expect(parseKimiAgentMarkdown(
      '---\nname: Not Kebab\ndescription: "d"\n---\nbody\n',
      path,
    )).toBeNull();
  });
});

describe('serializeKimiAgentMarkdown', () => {
  it('round-trips managed fields and unmanaged frontmatter', () => {
    const original = parseKimiAgentMarkdown(FULL_MARKDOWN, `${KIMI_BRAND_AGENTS_PATH}/deep-reviewer.md`);
    expect(original).not.toBeNull();

    const roundTripped = parseKimiAgentMarkdown(
      serializeKimiAgentMarkdown(original!),
      original!.filePath,
    );

    expect(roundTripped).toEqual(original);
  });

  it('omits optional fields when unset', () => {
    const serialized = serializeKimiAgentMarkdown(makeAgent({ filePath: undefined as never }));

    expect(serialized).toBe('---\nname: code-reviewer\ndescription: Reviews code.\n---\nReview carefully.');
  });
});

describe('KimiAgentStorage', () => {
  it('scans both vault agent directories and skips non-markdown files', async () => {
    const storage = new KimiAgentStorage(createMockAdapter({
      [`${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`]: REVIEWER_MARKDOWN,
      [`${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`]: NAME_FROM_FILE_MARKDOWN,
      [`${KIMI_BRAND_AGENTS_PATH}/README.md`]: 'no frontmatter',
      [`${KIMI_BRAND_AGENTS_PATH}/notes.txt`]: 'not markdown',
    }));

    const agents = await storage.loadAll();

    expect(agents.map((agent) => agent.name).sort()).toEqual(['code-reviewer', 'note-auditor']);
  });

  it('lets brand-directory agents win name conflicts', async () => {
    const storage = new KimiAgentStorage(createMockAdapter({
      [`${KIMI_GENERIC_AGENTS_PATH}/shared.md`]: `---
name: shared
description: "Generic variant."
---
Generic prompt.
`,
      [`${KIMI_BRAND_AGENTS_PATH}/shared.md`]: `---
name: shared
description: "Brand variant."
---
Brand prompt.
`,
    }));

    const agents = await storage.loadAll();

    expect(agents).toHaveLength(1);
    expect(agents[0].description).toBe('Brand variant.');
  });

  it('returns an empty list when no agent directories exist', async () => {
    const storage = new KimiAgentStorage(createMockAdapter({}));

    expect(await storage.loadAll()).toEqual([]);
  });

  it('creates agent files in the brand directory only', async () => {
    const files: Record<string, string> = {};
    const storage = new KimiAgentStorage(createMockAdapter(files));

    await storage.save(makeAgent({ modelPreference: 'primary', tools: ['read'] }));

    expect(files[`${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`]).toBe(
      '---\nname: code-reviewer\ndescription: Reviews code.\ntools:\n  - read\nmodel_preference: primary\n---\nReview carefully.',
    );
    expect(Object.keys(files).some((key) => key.startsWith(KIMI_GENERIC_AGENTS_PATH))).toBe(false);
  });

  it('rejects invalid agents without writing', async () => {
    const files: Record<string, string> = {};
    const storage = new KimiAgentStorage(createMockAdapter(files));

    await expect(storage.save(makeAgent({ name: 'Bad Name' }))).rejects.toThrow();
    await expect(storage.save(makeAgent({ description: '' }))).rejects.toThrow();
    await expect(storage.save(makeAgent({ prompt: '  ' }))).rejects.toThrow();
    expect(files).toEqual({});
  });

  it('preserves unmanaged frontmatter when editing an existing file', async () => {
    const files = { [`${KIMI_BRAND_AGENTS_PATH}/deep-reviewer.md`]: FULL_MARKDOWN };
    const storage = new KimiAgentStorage(createMockAdapter(files));
    const existing = (await storage.loadAll())[0];

    await storage.save({ ...existing, description: 'Updated description.' }, existing);

    const rewritten = parseKimiAgentMarkdown(
      files[`${KIMI_BRAND_AGENTS_PATH}/deep-reviewer.md`],
      `${KIMI_BRAND_AGENTS_PATH}/deep-reviewer.md`,
    );
    expect(rewritten?.description).toBe('Updated description.');
    expect(rewritten?.extraFrontmatter).toEqual({
      custom_unknown: 'keep me',
      override: true,
      subagents: ['helper'],
      whenToUse: 'Use for deep audits.',
    });
    expect(rewritten?.modelPreference).toBe('secondary');
  });

  it('deletes the old brand file on rename but never touches the generic directory', async () => {
    const files: Record<string, string> = {
      [`${KIMI_BRAND_AGENTS_PATH}/old-name.md`]: REVIEWER_MARKDOWN.replace('code-reviewer', 'old-name'),
      [`${KIMI_GENERIC_AGENTS_PATH}/generic-one.md`]: NAME_FROM_FILE_MARKDOWN,
    };
    const storage = new KimiAgentStorage(createMockAdapter(files));

    const brandAgent = makeAgent({
      filePath: `${KIMI_BRAND_AGENTS_PATH}/old-name.md`,
      name: 'old-name',
    });
    await storage.save({ ...brandAgent, name: 'new-name' }, brandAgent);
    expect(files[`${KIMI_BRAND_AGENTS_PATH}/new-name.md`]).toBeDefined();
    expect(files[`${KIMI_BRAND_AGENTS_PATH}/old-name.md`]).toBeUndefined();

    const genericAgent = makeAgent({
      filePath: `${KIMI_GENERIC_AGENTS_PATH}/generic-one.md`,
      name: 'generic-one',
      description: 'Audits vault notes.',
    });
    await storage.save(genericAgent, genericAgent);
    expect(files[`${KIMI_BRAND_AGENTS_PATH}/generic-one.md`]).toBeDefined();
    expect(files[`${KIMI_GENERIC_AGENTS_PATH}/generic-one.md`]).toBeDefined();
  });

  it('deletes brand files and refuses to delete generic-directory agents', async () => {
    const files = {
      [`${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`]: REVIEWER_MARKDOWN,
      [`${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`]: NAME_FROM_FILE_MARKDOWN,
    };
    const storage = new KimiAgentStorage(createMockAdapter(files));

    await storage.delete(makeAgent());
    expect(files[`${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`]).toBeUndefined();

    await expect(storage.delete(makeAgent({
      filePath: `${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`,
      name: 'note-auditor',
    }))).rejects.toThrow();
    expect(files[`${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`]).toBeDefined();
  });
});
