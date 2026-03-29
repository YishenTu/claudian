import {
  CodexSubagentSettings,
  validateCodexNicknameCandidates,
  validateCodexSubagentName,
} from '@/features/settings/ui/CodexSubagentSettings';
import type { CodexSubagentStorage } from '@/providers/codex/storage/CodexSubagentStorage';
import type { CodexSubagentDefinition } from '@/providers/codex/types/subagent';

function makeAgent(name: string, overrides: Partial<CodexSubagentDefinition> = {}): CodexSubagentDefinition {
  return {
    name,
    description: `${name} description`,
    developerInstructions: `${name} instructions`,
    filePath: `.codex/agents/${name}.toml`,
    ...overrides,
  };
}

function createMockStorage(
  agents: CodexSubagentDefinition[] = [],
): CodexSubagentStorage {
  return {
    loadAll: jest.fn().mockResolvedValue(agents),
    load: jest.fn().mockImplementation(async (a: CodexSubagentDefinition) =>
      agents.find(x => x.name === a.name) ?? null,
    ),
    save: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as CodexSubagentStorage;
}

function createMockContainer(): any {
  const children: any[] = [];
  const el: any = {
    empty: jest.fn(() => { children.length = 0; }),
    createDiv: jest.fn((opts: any) => {
      const child = createMockContainer();
      child.cls = opts?.cls;
      children.push(child);
      return child;
    }),
    createSpan: jest.fn((opts: any) => {
      const child = createMockContainer();
      child.cls = opts?.cls;
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    }),
    createEl: jest.fn((_tag: string, opts: any) => {
      const child = createMockContainer();
      child.cls = opts?.cls;
      if (opts?.text) child.textContent = opts.text;
      if (opts?.attr) child.attr = opts.attr;
      child.addEventListener = jest.fn();
      children.push(child);
      return child;
    }),
    setText: jest.fn((text: string) => { el.textContent = text; }),
    children,
    textContent: '',
    addEventListener: jest.fn(),
    addClass: jest.fn(),
    style: {},
  };
  return el;
}

jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
  Modal: class MockModal {
    contentEl = createMockContainer();
    modalEl = createMockContainer();
    setTitle = jest.fn();
    close = jest.fn();
    open = jest.fn();
    onOpen() {}
    onClose() {}
  },
  Notice: jest.fn(),
  Setting: jest.fn().mockImplementation(() => {
    const setting: any = {
      setName: jest.fn().mockReturnThis(),
      setDesc: jest.fn().mockReturnThis(),
      setHeading: jest.fn().mockReturnThis(),
      addText: jest.fn().mockImplementation((cb: any) => {
        const textComponent: any = { inputEl: { value: '' } };
        textComponent.setValue = jest.fn((v: string) => { textComponent.inputEl.value = v; return textComponent; });
        textComponent.setPlaceholder = jest.fn(() => textComponent);
        cb(textComponent);
        return setting;
      }),
      addDropdown: jest.fn().mockImplementation((cb: any) => {
        const dropdownComponent: any = {
          addOption: jest.fn(() => dropdownComponent),
          setValue: jest.fn(() => dropdownComponent),
          onChange: jest.fn(),
        };
        cb(dropdownComponent);
        return setting;
      }),
      addToggle: jest.fn().mockReturnThis(),
    };
    return setting;
  }),
}));

describe('validateCodexSubagentName', () => {
  it('accepts lowercase with hyphens', () => {
    expect(validateCodexSubagentName('code-reviewer')).toBeNull();
  });

  it('accepts lowercase with underscores (Codex convention)', () => {
    expect(validateCodexSubagentName('pr_explorer')).toBeNull();
    expect(validateCodexSubagentName('docs_researcher')).toBeNull();
    expect(validateCodexSubagentName('code_mapper')).toBeNull();
  });

  it('accepts mixed hyphens and underscores', () => {
    expect(validateCodexSubagentName('my-code_reviewer')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateCodexSubagentName('')).not.toBeNull();
  });

  it('rejects uppercase', () => {
    expect(validateCodexSubagentName('Code_Reviewer')).not.toBeNull();
  });

  it('rejects spaces', () => {
    expect(validateCodexSubagentName('code reviewer')).not.toBeNull();
  });

  it('rejects names over 64 characters', () => {
    expect(validateCodexSubagentName('a'.repeat(65))).not.toBeNull();
  });
});

describe('CodexSubagentSettings', () => {
  describe('validation', () => {
    it('accepts documented nickname candidates', () => {
      expect(
        validateCodexNicknameCandidates(['Atlas', 'Delta-1', 'Echo_2', 'Scout 3']),
      ).toBeNull();
    });

    it('rejects duplicate nickname candidates', () => {
      expect(
        validateCodexNicknameCandidates(['Atlas', 'atlas']),
      ).toBe('Nickname candidates must be unique');
    });

    it('rejects nickname candidates with invalid characters', () => {
      expect(
        validateCodexNicknameCandidates(['Atlas', 'Delta!']),
      ).toBe(
        'Nickname candidates can only contain ASCII letters, numbers, spaces, hyphens, and underscores',
      );
    });
  });

  describe('constructor', () => {
    it('creates settings with storage reference', () => {
      const container = createMockContainer();
      const storage = createMockStorage([makeAgent('reviewer')]);

      const settings = new CodexSubagentSettings(container, storage);
      expect(settings).toBeInstanceOf(CodexSubagentSettings);
    });
  });

  describe('render', () => {
    it('calls loadAll on render', async () => {
      const container = createMockContainer();
      const storage = createMockStorage([makeAgent('reviewer')]);

      new CodexSubagentSettings(container, storage);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(storage.loadAll).toHaveBeenCalled();
    });

    it('shows empty state when no agents', async () => {
      const container = createMockContainer();
      const storage = createMockStorage([]);

      new CodexSubagentSettings(container, storage);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(container.empty).toHaveBeenCalled();
    });

    it('renders multiple agents', async () => {
      const container = createMockContainer();
      const storage = createMockStorage([
        makeAgent('reviewer'),
        makeAgent('explorer'),
      ]);

      new CodexSubagentSettings(container, storage);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(storage.loadAll).toHaveBeenCalled();
    });
  });
});
