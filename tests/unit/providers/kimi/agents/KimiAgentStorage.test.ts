import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import {
  KIMI_BRAND_AGENTS_PATH,
  KIMI_GENERIC_AGENTS_PATH,
  KimiAgentStorage,
  parseKimiAgentMarkdown,
} from '@/providers/kimi/agents/KimiAgentStorage';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return {
    read: jest.fn(async (targetPath: string) => {
      if (!(targetPath in files)) {
        throw new Error(`File not found: ${targetPath}`);
      }
      return files[targetPath];
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

describe('parseKimiAgentMarkdown', () => {
  it('parses the kimi agent file format', () => {
    const agent = parseKimiAgentMarkdown(REVIEWER_MARKDOWN, `${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`);

    expect(agent).toEqual({
      description: 'Reviews code for correctness.',
      filePath: `${KIMI_BRAND_AGENTS_PATH}/code-reviewer.md`,
      name: 'code-reviewer',
      prompt: 'Review code like an owner.',
    });
  });

  it('falls back to the file name when frontmatter omits name', () => {
    const agent = parseKimiAgentMarkdown(
      NAME_FROM_FILE_MARKDOWN,
      `${KIMI_GENERIC_AGENTS_PATH}/note-auditor.md`,
    );

    expect(agent?.name).toBe('note-auditor');
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
});
