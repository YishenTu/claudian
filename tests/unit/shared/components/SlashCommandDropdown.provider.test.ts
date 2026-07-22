import { createMockEl } from '@test/helpers/mockElement';

import type { ProviderCommandDropdownConfig } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
} from '@/shared/components/SlashCommandDropdown';

jest.mock('@/core/commands/builtInCommands', () => ({
  getBuiltInCommandsForDropdown: jest.fn((providerId?: string) => {
    const all = [
      { id: 'builtin:clear', name: 'clear', description: 'Start a new conversation', content: '' },
      { id: 'builtin:add-dir', name: 'add-dir', description: 'Add external context directory', content: '', argumentHint: 'path/to/directory' },
      { id: 'builtin:resume', name: 'resume', description: 'Resume a previous conversation', content: '', supportsNativeHistory: true },
      { id: 'builtin:fork', name: 'fork', description: 'Fork entire conversation to new session', content: '', supportsFork: true },
    ];
    if (!providerId) return all;
    if (providerId === 'codex') {
      return all;
    }
    return all;
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

function getDiscoveryState(containerEl: any): { text: string; retry: any | null } | null {
  const dropdownEl = containerEl.children.find(
    (c: any) => c.hasClass('claudian-slash-dropdown')
  );
  const stateEl = dropdownEl?.children.find(
    (c: any) => c.hasClass('claudian-slash-provider-state')
  );
  if (!stateEl) return null;
  const messageEl = stateEl.children.find(
    (c: any) => c.hasClass('claudian-slash-provider-state-message')
  );
  const retry = stateEl.children.find(
    (c: any) => c.hasClass('claudian-slash-provider-retry')
  ) ?? null;
  return { text: messageEl?.textContent ?? '', retry };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
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

    it('includes Codex-compatible built-ins in the Codex dropdown', async () => {
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
      expect(names).toContain('/add-dir');
      expect(names).toContain('/resume');
      expect(names).toContain('/fork');

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
      const codexEntries = jest.fn().mockResolvedValue({
        status: 'ready',
        items: CODEX_ENTRIES,
      });
      dropdown.setProviderCatalog(CODEX_CONFIG, codexEntries);

      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(codexEntries).toHaveBeenCalledTimes(1);

      dropdown.destroy();
    });

    it('immediately removes rendered entries when the provider catalog changes', async () => {
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { providerConfig: CLAUDE_CONFIG, getProviderEntries: async () => CLAUDE_ENTRIES },
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(getRenderedCommandNames(containerEl)).toContain('/review');

      dropdown.setProviderCatalog(
        CODEX_CONFIG,
        async () => ({ status: 'ready', items: [CODEX_ENTRIES[0]] }),
      );

      expect(dropdown.isVisible()).toBe(false);
      expect(getRenderedCommandNames(containerEl)).not.toContain('/review');
      expect(callbacks.onHide).toHaveBeenCalled();

      dropdown.destroy();
    });
  });

  describe('typed provider discovery', () => {
    it.each([
      ['codex', ['/', '$'], 'claudian-v2-shared', '$'],
      ['grok', ['/'], 'claudian-v2-shared', '/'],
      ['pi', ['/'], 'skill:claudian-v2-shared', '/'],
      ['opencode', ['/'], 'claudian-v2-shared', '/'],
    ] as const)(
      'settles discovery and renders every %s protocol entry before a prompt',
      async (providerId, triggerChars, commandName, displayPrefix) => {
        const entries: [ProviderCommandEntry, ProviderCommandEntry] = [
          {
            id: `${providerId}:fixture-1`,
            providerId,
            kind: 'skill' as const,
            name: commandName,
            description: 'First provider-advertised entry',
            content: '',
            scope: 'runtime' as const,
            source: 'sdk' as const,
            isEditable: false,
            isDeletable: false,
            displayPrefix,
            insertPrefix: displayPrefix,
          },
          {
            id: `${providerId}:fixture-2`,
            providerId,
            kind: 'skill' as const,
            name: `${commandName}-second`,
            description: 'Second provider-advertised entry',
            content: '',
            scope: 'runtime' as const,
            source: 'sdk' as const,
            isEditable: false,
            isDeletable: false,
            displayPrefix,
            insertPrefix: displayPrefix,
          },
        ];
        const dropdown = new SlashCommandDropdown(
          containerEl,
          inputEl,
          callbacks,
          {
            providerConfig: {
              providerId,
              triggerChars: [...triggerChars],
              builtInPrefix: '/',
              skillPrefix: displayPrefix,
              commandPrefix: '/',
            },
            discoverProviderEntries: async () => ({ status: 'ready', items: entries }),
          },
        );

        inputEl.value = '/';
        inputEl.selectionStart = 1;
        dropdown.handleInputChange();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(getRenderedCommandNames(containerEl)).toEqual(expect.arrayContaining([
          `${displayPrefix}${commandName}`,
          `${displayPrefix}${commandName}-second`,
        ]));
        expect(getDiscoveryState(containerEl)).toBeNull();

        dropdown.destroy();
      },
    );

    it('renders built-ins with loading immediately, then ready entries without another input', async () => {
      const response = deferred<ProviderCommandDiscoveryResult<ProviderCommandEntry>>();
      const discoverProviderEntries = jest.fn().mockReturnValue(response.promise);
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { providerConfig: CLAUDE_CONFIG, discoverProviderEntries },
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();

      expect(getRenderedCommandNames(containerEl)).toContain('/clear');
      expect(getDiscoveryState(containerEl)?.text).toBe('Loading provider commands…');

      response.resolve({ status: 'ready', items: [CLAUDE_ENTRIES[0]] });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(getRenderedCommandNames(containerEl)).toContain('/review');
      expect(getDiscoveryState(containerEl)).toBeNull();
      expect(discoverProviderEntries).toHaveBeenCalledTimes(1);

      dropdown.destroy();
    });

    it('replaces an unresponsive provider discovery with a retryable error', async () => {
      jest.useFakeTimers();
      try {
        const dropdown = new SlashCommandDropdown(
          containerEl,
          inputEl,
          callbacks,
          {
            providerConfig: CLAUDE_CONFIG,
            discoverProviderEntries: () => new Promise(() => undefined),
          },
        );

        inputEl.value = '/';
        inputEl.selectionStart = 1;
        dropdown.handleInputChange();
        expect(getDiscoveryState(containerEl)?.text).toBe('Loading provider commands…');

        await jest.advanceTimersByTimeAsync(10_000);

        const state = getDiscoveryState(containerEl);
        expect(state?.text).toBe('Provider command discovery timed out');
        expect(state?.retry).not.toBeNull();

        dropdown.destroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it.each([
      [{ status: 'empty' } as const, 'No provider commands advertised'],
      [
        { status: 'requires-session', message: 'Start a conversation to load commands.' } as const,
        'Start a conversation to load commands.',
      ],
    ])('renders the %s state distinctly', async (result, message) => {
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { providerConfig: CLAUDE_CONFIG, discoverProviderEntries: async () => result },
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(getDiscoveryState(containerEl)?.text).toBe(message);
      expect(getDiscoveryState(containerEl)?.retry).toBeNull();

      dropdown.destroy();
    });

    it('renders a retryable error and retries from its action', async () => {
      const discoverProviderEntries = jest.fn()
        .mockResolvedValueOnce({
          status: 'error',
          message: 'Could not load provider commands',
          retryable: true,
        })
        .mockResolvedValueOnce({ status: 'ready', items: [CLAUDE_ENTRIES[0]] });
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { providerConfig: CLAUDE_CONFIG, discoverProviderEntries },
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));

      const state = getDiscoveryState(containerEl);
      expect(state?.text).toBe('Could not load provider commands');
      expect(state?.retry).not.toBeNull();

      state!.retry.click();
      expect(getDiscoveryState(containerEl)?.text).toBe('Loading provider commands…');
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(getRenderedCommandNames(containerEl)).toContain('/review');
      expect(discoverProviderEntries).toHaveBeenCalledTimes(2);

      dropdown.destroy();
    });

    it('retries a failed discovery when the trigger is reopened', async () => {
      const discoverProviderEntries = jest.fn()
        .mockResolvedValueOnce({
          status: 'error',
          message: 'Could not load provider commands',
          retryable: true,
        })
        .mockResolvedValueOnce({ status: 'empty' });
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { providerConfig: CLAUDE_CONFIG, discoverProviderEntries },
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));
      dropdown.hide();

      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(discoverProviderEntries).toHaveBeenCalledTimes(2);
      expect(getDiscoveryState(containerEl)?.text).toBe('No provider commands advertised');

      dropdown.destroy();
    });

    it('discards an older provider completion after setProviderCatalog', async () => {
      const oldResponse = deferred<ProviderCommandDiscoveryResult<ProviderCommandEntry>>();
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { providerConfig: CLAUDE_CONFIG, discoverProviderEntries: () => oldResponse.promise },
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();

      dropdown.setProviderCatalog(
        CODEX_CONFIG,
        async () => ({ status: 'ready', items: [CODEX_ENTRIES[0]] }),
      );
      inputEl.value = '$';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));

      oldResponse.resolve({ status: 'ready', items: [CLAUDE_ENTRIES[0]] });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(getRenderedCommandNames(containerEl)).toContain('$analyze');
      expect(getRenderedCommandNames(containerEl)).not.toContain('/review');

      dropdown.destroy();
    });

    it('preserves exact provider prefixes and qualified names', async () => {
      const qualifiedEntry: ProviderCommandEntry = {
        ...CLAUDE_ENTRIES[0],
        id: 'grok-local-review',
        providerId: 'grok',
        name: 'local:review',
        displayPrefix: '/',
        insertPrefix: '/',
      };
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        {
          providerConfig: { ...CLAUDE_CONFIG, providerId: 'grok' },
          discoverProviderEntries: async () => ({ status: 'ready', items: [qualifiedEntry] }),
        },
      );

      inputEl.value = '/local';
      inputEl.selectionStart = 6;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));
      dropdown.handleKeydown({ key: 'Enter', preventDefault: jest.fn() } as any);

      expect(inputEl.value).toBe('/local:review ');

      dropdown.destroy();
    });

    it('never invokes typed discovery for the legacy catalog-only path', async () => {
      const legacyEntries = jest.fn().mockResolvedValue(CLAUDE_ENTRIES);
      const typedDiscovery = jest.fn();
      const dropdown = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        {
          providerConfig: CLAUDE_CONFIG,
          getProviderEntries: legacyEntries,
          discoverProviderEntries: typedDiscovery,
        },
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(legacyEntries).toHaveBeenCalledTimes(1);
      expect(typedDiscovery).not.toHaveBeenCalled();

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
