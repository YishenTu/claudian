import { createMockEl } from '@test/helpers/mockElement';

import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
} from '@/shared/components/SlashCommandDropdown';

jest.mock('@/core/commands/builtInCommands', () => ({
  getBuiltInCommandsForDropdown: jest.fn((providerId?: string) => {
    const all = [
      { id: 'builtin:clear', name: 'clear', description: 'Start a new conversation', content: '' },
      { id: 'builtin:add-dir', name: 'add-dir', description: 'Add external context directory', content: '', argumentHint: 'path/to/directory', providers: ['claude'] },
      { id: 'builtin:resume', name: 'resume', description: 'Resume a previous conversation', content: '', providers: ['claude'] },
      { id: 'builtin:fork', name: 'fork', description: 'Fork entire conversation to new session', content: '', providers: ['claude'] },
    ];
    if (!providerId) return all;
    return all.filter((c: any) => !c.providers || c.providers.includes(providerId));
  }),
}));

function createMockInput(): any {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    focus: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
}

function createMockCallbacks(overrides: Partial<SlashCommandDropdownCallbacks> = {}): SlashCommandDropdownCallbacks {
  return {
    onSelect: jest.fn(),
    onHide: jest.fn(),
    ...overrides,
  };
}

function getRenderedItems(containerEl: any): { name: string; description: string }[] {
  const dropdownEl = containerEl.children.find(
    (c: any) => c.hasClass('claudian-slash-dropdown')
  );
  if (!dropdownEl) return [];
  const items = dropdownEl.querySelectorAll('.claudian-slash-item');
  return items.map((item: any) => {
    const nameSpan = item.children.find((c: any) => c.hasClass('claudian-slash-name'));
    const descDiv = item.children.find((c: any) => c.hasClass('claudian-slash-desc'));
    return {
      name: nameSpan?.textContent ?? '',
      description: descDiv?.textContent ?? '',
    };
  });
}

function getRenderedCommandNames(containerEl: any): string[] {
  return getRenderedItems(containerEl).map(i => i.name);
}

const CLAUDE_CONFIG: ProviderCommandDropdownConfig = {
  providerId: 'claude',
  triggerChars: ['/'],
  builtInPrefix: '/',
  skillPrefix: '/',
  commandPrefix: '/',
};

const CODEX_CONFIG: ProviderCommandDropdownConfig = {
  providerId: 'codex',
  triggerChars: ['/', '$'],
  builtInPrefix: '/',
  skillPrefix: '$',
  commandPrefix: '/',
};

const CLAUDE_ENTRIES: ProviderCommandEntry[] = [
  {
    id: 'cmd-review', providerId: 'claude', kind: 'command', name: 'review',
    description: 'Review code', content: '', scope: 'vault', source: 'user',
    isEditable: true, isDeletable: true, displayPrefix: '/', insertPrefix: '/',
  },
  {
    id: 'skill-deploy', providerId: 'claude', kind: 'skill', name: 'deploy',
    description: 'Deploy app', content: '', scope: 'vault', source: 'user',
    isEditable: true, isDeletable: true, displayPrefix: '/', insertPrefix: '/',
  },
];

const CODEX_ENTRIES: ProviderCommandEntry[] = [
  {
    id: 'codex-skill-analyze', providerId: 'codex', kind: 'skill', name: 'analyze',
    description: 'Analyze code', content: '', scope: 'vault', source: 'user',
    isEditable: true, isDeletable: true, displayPrefix: '$', insertPrefix: '$',
  },
];

describe('SlashCommandDropdown - provider catalog', () => {
  let containerEl: any;
  let inputEl: any;
  let callbacks: SlashCommandDropdownCallbacks;

  beforeEach(() => {
    containerEl = createMockEl();
    inputEl = createMockInput();
    callbacks = createMockCallbacks();
  });

  describe('Claude provider (/ trigger)', () => {
    it('shows provider entries on / trigger', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      // Built-ins + Claude entries (all use / prefix)
      expect(names).toContain('/clear');
      expect(names).toContain('/review');
      expect(names).toContain('/deploy');

      dropdown.destroy();
    });

    it('displays Claude entries with / prefix', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries }
      );

      inputEl.value = '/rev';
      inputEl.selectionStart = 4;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/review');

      dropdown.destroy();
    });
  });

  describe('Codex provider (/ and $ triggers)', () => {
    it('shows Codex skills on $ trigger', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('$analyze');
      // Built-ins should NOT show on $ trigger
      expect(names).not.toContain('clear');

      dropdown.destroy();
    });

    it('shows built-ins + skills on / trigger at position 0', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/clear');
      expect(names).toContain('$analyze');

      dropdown.destroy();
    });

    it('excludes Claude-only built-ins from Codex dropdown', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/clear');
      expect(names).not.toContain('/add-dir');
      expect(names).not.toContain('/resume');
      expect(names).not.toContain('/fork');

      dropdown.destroy();
    });

    it('inserts $name for Codex skill selection', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Simulate selecting the first (only) item via handleKeydown Enter
      const event = { key: 'Enter', preventDefault: jest.fn() } as any;
      dropdown.handleKeydown(event);

      // Input should now contain $analyze
      expect(inputEl.value).toContain('$analyze');

      dropdown.destroy();
    });
  });

  describe('provider switch', () => {
    it('resets cached entries on provider switch', async () => {
      const claudeEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries: claudeEntries }
      );

      // Fetch Claude entries
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(claudeEntries).toHaveBeenCalledTimes(1);

      // Switch provider
      const codexEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      dropdown.setProviderCatalog(CODEX_CONFIG, codexEntries);

      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(codexEntries).toHaveBeenCalledTimes(1);

      dropdown.destroy();
    });
  });

  describe('mid-sentence trigger detection', () => {
    it('opens Codex $ trigger mid-sentence', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'some text $';
      inputEl.selectionStart = 11;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('$analyze');

      dropdown.destroy();
    });

    it('opens Claude / trigger mid-sentence', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CLAUDE_CONFIG, getProviderEntries }
      );

      inputEl.value = 'check this /';
      inputEl.selectionStart = 12;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      expect(names).toContain('/review');

      dropdown.destroy();
    });

    it('does not show built-ins mid-sentence', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'some text /';
      inputEl.selectionStart = 11;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      // Mid-sentence: provider entries only, no built-ins
      expect(names).not.toContain('/clear');
      expect(names).not.toContain('/add-dir');

      dropdown.destroy();
    });

    it('does not open trigger without preceding whitespace', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'word$';
      inputEl.selectionStart = 5;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(dropdown.isVisible()).toBe(false);

      dropdown.destroy();
    });

    it('inserts correctly at mid-sentence position', async () => {
      const getProviderEntries = jest.fn().mockResolvedValue(CODEX_ENTRIES);
      const dropdown = new SlashCommandDropdown(
        containerEl, inputEl, callbacks, { providerConfig: CODEX_CONFIG, getProviderEntries }
      );

      inputEl.value = 'prefix $';
      inputEl.selectionStart = 8;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Select the item
      const event = { key: 'Enter', preventDefault: jest.fn() } as any;
      dropdown.handleKeydown(event);

      // Should replace $analyze at the mid-sentence position
      expect(inputEl.value).toBe('prefix $analyze ');

      dropdown.destroy();
    });
  });

});
