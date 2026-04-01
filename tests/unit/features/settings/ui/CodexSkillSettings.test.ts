import type { ProviderCommandCatalog } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import {
  type CodexSkillRootId,
  createCodexSkillPersistenceKey,
} from '@/providers/codex/storage/CodexSkillStorage';
import { CodexSkillModal, CodexSkillSettings } from '@/providers/codex/ui/CodexSkillSettings';

function makeEntry(name: string, scope: 'vault' | 'user' = 'vault'): ProviderCommandEntry {
  return {
    id: `codex-skill-${name}`,
    providerId: 'codex',
    kind: 'skill',
    name,
    description: `${name} description`,
    content: `${name} content`,
    scope,
    source: 'user',
    isEditable: scope === 'vault',
    isDeletable: scope === 'vault',
    displayPrefix: '$',
    insertPrefix: '$',
  };
}

function createMockCatalog(
  vaultEntries: ProviderCommandEntry[] = [],
): ProviderCommandCatalog {
  return {
    listDropdownEntries: jest.fn().mockResolvedValue(vaultEntries),
    listVaultEntries: jest.fn().mockResolvedValue(vaultEntries),
    saveVaultEntry: jest.fn().mockResolvedValue(undefined),
    deleteVaultEntry: jest.fn().mockResolvedValue(undefined),
    setRuntimeCommands: jest.fn(),
    getDropdownConfig: jest.fn().mockReturnValue({
      triggerChars: ['/', '$'],
      builtInPrefix: '/',
      skillPrefix: '$',
      commandPrefix: '/',
    }),
    refresh: jest.fn().mockResolvedValue(undefined),
  };
}

// Minimal mock for the Obsidian containerEl
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

// Mock setIcon since it's from Obsidian
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
      addTextArea: jest.fn().mockReturnThis(),
      addButton: jest.fn().mockReturnThis(),
      addDropdown: jest.fn().mockImplementation((cb: any) => {
        const dropdownComponent: any = {
          addOption: jest.fn().mockReturnValue(undefined),
          setValue: jest.fn(),
          onChange: jest.fn(),
          setDisabled: jest.fn(),
        };
        dropdownComponent.addOption = jest.fn(() => dropdownComponent);
        dropdownComponent.setValue = jest.fn(() => dropdownComponent);
        cb(dropdownComponent);
        return setting;
      }),
      addToggle: jest.fn().mockReturnThis(),
      settingEl: { style: {} },
    };
    return setting;
  }),
}));

describe('CodexSkillModal', () => {
  describe('directory selection', () => {
    it('defaults persistenceKey to .codex/skills for new skills', async () => {
      const savedEntries: ProviderCommandEntry[] = [];
      const modal = new CodexSkillModal(
        {} as any,
        null,
        async (entry) => { savedEntries.push(entry); },
      );

      modal.onOpen();

      // Simulate filling in required fields and saving
      const nameInput = modal.getTestInputs().nameInput;
      const contentArea = modal.getTestInputs().contentArea;
      nameInput.value = 'test-skill';
      contentArea.value = 'Do the thing';

      await modal.getTestInputs().triggerSave();

      expect(savedEntries).toHaveLength(1);
      expect(savedEntries[0].persistenceKey).toBe(
        createCodexSkillPersistenceKey({ rootId: 'vault-codex' }),
      );
    });

    it('preserves existing persistenceKey when editing', async () => {
      const existing = makeEntry('existing-skill');
      existing.persistenceKey = createCodexSkillPersistenceKey({
        rootId: 'vault-agents',
        currentName: 'existing-skill',
      });

      const savedEntries: ProviderCommandEntry[] = [];
      const modal = new CodexSkillModal(
        {} as any,
        existing,
        async (entry) => { savedEntries.push(entry); },
      );

      modal.onOpen();

      const contentArea = modal.getTestInputs().contentArea;
      contentArea.value = 'Updated content';

      await modal.getTestInputs().triggerSave();

      expect(savedEntries).toHaveLength(1);
      expect(savedEntries[0].persistenceKey).toBe(
        createCodexSkillPersistenceKey({
          rootId: 'vault-agents',
          currentName: 'existing-skill',
        }),
      );
    });

    it('allows changing directory via dropdown', async () => {
      const savedEntries: ProviderCommandEntry[] = [];
      const modal = new CodexSkillModal(
        {} as any,
        null,
        async (entry) => { savedEntries.push(entry); },
      );

      modal.onOpen();

      const { nameInput, contentArea, setDirectory } = modal.getTestInputs();
      nameInput.value = 'new-skill';
      contentArea.value = 'Content here';
      setDirectory('vault-agents' as CodexSkillRootId);

      await modal.getTestInputs().triggerSave();

      expect(savedEntries).toHaveLength(1);
      expect(savedEntries[0].persistenceKey).toBe(
        createCodexSkillPersistenceKey({ rootId: 'vault-agents' }),
      );
    });
  });
});

describe('CodexSkillSettings', () => {
  describe('constructor', () => {
    it('creates settings with catalog reference', () => {
      const container = createMockContainer();
      const catalog = createMockCatalog([makeEntry('test-skill')]);

      const settings = new CodexSkillSettings(container, catalog);

      expect(settings).toBeInstanceOf(CodexSkillSettings);
    });
  });

  describe('render', () => {
    it('calls listVaultEntries on render', async () => {
      const container = createMockContainer();
      const catalog = createMockCatalog([makeEntry('test-skill')]);

      new CodexSkillSettings(container, catalog);

      // The render is async; wait for it
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(catalog.listVaultEntries).toHaveBeenCalled();
    });

    it('shows empty state when no vault skills', async () => {
      const container = createMockContainer();
      const catalog = createMockCatalog([]);

      new CodexSkillSettings(container, catalog);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should create some children for the empty state
      expect(container.empty).toHaveBeenCalled();
    });

    it('does not show home-level skills', async () => {
      const container = createMockContainer();
      const vaultEntries = [makeEntry('vault-skill', 'vault')];
      const catalog = createMockCatalog(vaultEntries);

      new CodexSkillSettings(container, catalog);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Only vault entries should be listed
      expect(catalog.listVaultEntries).toHaveBeenCalled();
      // NOT listDropdownEntries (which would include home entries)
      expect(catalog.listDropdownEntries).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('calls deleteVaultEntry on the catalog', async () => {
      const container = createMockContainer();
      const entries = [makeEntry('removable')];
      const catalog = createMockCatalog(entries);

      const settings = new CodexSkillSettings(container, catalog);
      await new Promise(resolve => setTimeout(resolve, 10));

      await settings.deleteEntry(entries[0]);

      expect(catalog.deleteVaultEntry).toHaveBeenCalledWith(entries[0]);
    });
  });

  describe('refresh', () => {
    it('refreshes through the catalog and re-renders vault entries', async () => {
      const container = createMockContainer();
      const catalog = createMockCatalog([makeEntry('test-skill')]);

      const settings = new CodexSkillSettings(container, catalog);
      await new Promise(resolve => setTimeout(resolve, 10));

      (catalog.refresh as jest.Mock).mockClear();
      (catalog.listVaultEntries as jest.Mock).mockClear();
      (catalog.listDropdownEntries as jest.Mock).mockClear();

      await settings.refresh();

      expect(catalog.refresh).toHaveBeenCalledTimes(1);
      expect(catalog.listVaultEntries).toHaveBeenCalledTimes(1);
      expect(catalog.listDropdownEntries).not.toHaveBeenCalled();
    });
  });
});
