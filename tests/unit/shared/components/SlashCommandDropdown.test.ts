/**
 * Tests for SlashCommandDropdown - dropdown UI for selecting slash commands.
 *
 * Tests cover:
 * - FILTERED_SDK_COMMANDS filtering (SDK commands that don't apply to Claudian)
 * - Hidden commands filtering (user-configured hidden commands)
 * - Built-in commands exemption from hiding (essential UI actions)
 * - Deduplication (built-in commands take priority over SDK)
 * - SDK command caching and retry on empty results
 * - Race condition handling via requestId
 */

import type { SlashCommand } from '@/core/types';
import {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
} from '@/shared/components/SlashCommandDropdown';

// Mock getBuiltInCommandsForDropdown
jest.mock('@/core/commands', () => ({
  getBuiltInCommandsForDropdown: jest.fn(() => [
    { id: 'builtin:clear', name: 'clear', description: 'Start a new conversation', content: '' },
    { id: 'builtin:add-dir', name: 'add-dir', description: 'Add external context directory', content: '', argumentHint: 'path/to/directory' },
  ]),
}));

// Helper to create mock DOM element with Obsidian-like API
function createMockElement(): any {
  const children: any[] = [];
  const classes = new Set<string>();

  const element: any = {
    children,
    style: {},
    textContent: '',
    hasClass: (cls: string) => classes.has(cls),
    addClass: (cls: string) => { classes.add(cls); return element; },
    removeClass: (cls: string) => { classes.delete(cls); return element; },
    empty: () => { children.length = 0; },
    remove: () => {},
    setText: (text: string) => { element.textContent = text; },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    querySelectorAll: (selector: string) => {
      if (selector === '.claudian-slash-item') {
        return children.filter(c => c.hasClass('claudian-slash-item'));
      }
      return [];
    },
    addEventListener: jest.fn(),
    scrollIntoView: jest.fn(),
    getBoundingClientRect: () => ({ top: 100, left: 50, width: 300, height: 40 }),
  };

  return element;
}

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

// SDK commands for testing
const SDK_COMMANDS: SlashCommand[] = [
  { id: 'sdk:commit', name: 'commit', description: 'Create a git commit', content: '', source: 'sdk' },
  { id: 'sdk:pr', name: 'pr', description: 'Create a pull request', content: '', source: 'sdk' },
  { id: 'sdk:review', name: 'review', description: 'Review code', content: '', source: 'sdk' },
  { id: 'sdk:my-custom', name: 'my-custom', description: 'Custom command', content: '', source: 'sdk' },
];

// Commands that should be filtered out (not shown in Claudian)
const FILTERED_SDK_COMMANDS_LIST: SlashCommand[] = [
  { id: 'sdk:compact', name: 'compact', description: 'Compact context', content: '', source: 'sdk' },
  { id: 'sdk:context', name: 'context', description: 'Show context', content: '', source: 'sdk' },
  { id: 'sdk:cost', name: 'cost', description: 'Show cost', content: '', source: 'sdk' },
  { id: 'sdk:init', name: 'init', description: 'Initialize project', content: '', source: 'sdk' },
  { id: 'sdk:release-notes', name: 'release-notes', description: 'Release notes', content: '', source: 'sdk' },
  { id: 'sdk:security-review', name: 'security-review', description: 'Security review', content: '', source: 'sdk' },
];

describe('SlashCommandDropdown', () => {
  let containerEl: any;
  let inputEl: any;
  let callbacks: SlashCommandDropdownCallbacks;
  let dropdown: SlashCommandDropdown;

  beforeEach(() => {
    containerEl = createMockElement();
    inputEl = createMockInput();
    callbacks = createMockCallbacks();
    dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks);
  });

  afterEach(() => {
    dropdown.destroy();
  });

  describe('constructor', () => {
    it('creates dropdown with container and input elements', () => {
      expect(dropdown).toBeInstanceOf(SlashCommandDropdown);
    });

    it('adds input event listener', () => {
      expect(inputEl.addEventListener).toHaveBeenCalledWith('input', expect.any(Function));
    });

    it('accepts optional hiddenCommands in options', () => {
      const hiddenCommands = new Set(['commit', 'pr']);
      const dropdownWithHidden = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { hiddenCommands }
      );
      expect(dropdownWithHidden).toBeInstanceOf(SlashCommandDropdown);
      dropdownWithHidden.destroy();
    });
  });

  describe('FILTERED_SDK_COMMANDS filtering', () => {
    it('should filter out compact, context, cost, init, release-notes, security-review', async () => {
      const allSdkCommands = [...SDK_COMMANDS, ...FILTERED_SDK_COMMANDS_LIST];
      const getSdkCommands = jest.fn().mockResolvedValue(allSdkCommands);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // Trigger dropdown
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();

      // Wait for async SDK fetch
      await new Promise(resolve => setTimeout(resolve, 10));

      // Access private filteredCommands to verify filtering
      const filteredCommands = (dropdownWithSdk as any).filteredCommands as SlashCommand[];
      const commandNames = filteredCommands.map(c => c.name);

      // Should NOT include filtered commands
      expect(commandNames).not.toContain('compact');
      expect(commandNames).not.toContain('context');
      expect(commandNames).not.toContain('cost');
      expect(commandNames).not.toContain('init');
      expect(commandNames).not.toContain('release-notes');
      expect(commandNames).not.toContain('security-review');

      // Should include other SDK commands
      expect(commandNames).toContain('commit');
      expect(commandNames).toContain('pr');
      expect(commandNames).toContain('review');
      expect(commandNames).toContain('my-custom');

      dropdownWithSdk.destroy();
    });
  });

  describe('hidden commands filtering', () => {
    it('should filter out user-hidden commands from SDK commands', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);
      const hiddenCommands = new Set(['commit', 'pr']);

      const dropdownWithHidden = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands },
        { hiddenCommands }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithHidden.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const filteredCommands = (dropdownWithHidden as any).filteredCommands as SlashCommand[];
      const commandNames = filteredCommands.map(c => c.name);

      // Hidden SDK commands should not appear
      expect(commandNames).not.toContain('commit');
      expect(commandNames).not.toContain('pr');

      // Non-hidden SDK commands should appear
      expect(commandNames).toContain('review');
      expect(commandNames).toContain('my-custom');

      dropdownWithHidden.destroy();
    });

    it('should NOT filter out built-in commands even if in hiddenCommands', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);
      // Try to hide built-in command 'clear'
      const hiddenCommands = new Set(['clear', 'add-dir']);

      const dropdownWithHidden = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands },
        { hiddenCommands }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithHidden.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const filteredCommands = (dropdownWithHidden as any).filteredCommands as SlashCommand[];
      const commandNames = filteredCommands.map(c => c.name);

      // Built-in commands should STILL appear (not subject to hiding)
      expect(commandNames).toContain('clear');
      expect(commandNames).toContain('add-dir');

      dropdownWithHidden.destroy();
    });
  });

  describe('deduplication', () => {
    it('should deduplicate commands by name (built-in takes priority)', async () => {
      // SDK has a command with same name as built-in
      const sdkWithDuplicate: SlashCommand[] = [
        { id: 'sdk:clear', name: 'clear', description: 'SDK clear command', content: '', source: 'sdk' },
        { id: 'sdk:commit', name: 'commit', description: 'Create commit', content: '', source: 'sdk' },
      ];
      const getSdkCommands = jest.fn().mockResolvedValue(sdkWithDuplicate);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/cle';
      inputEl.selectionStart = 4;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const filteredCommands = (dropdownWithSdk as any).filteredCommands as SlashCommand[];
      const clearCommands = filteredCommands.filter(c => c.name === 'clear');

      // Should only have one 'clear' command
      expect(clearCommands).toHaveLength(1);
      // And it should be the built-in one
      expect(clearCommands[0].id).toBe('builtin:clear');

      dropdownWithSdk.destroy();
    });
  });

  describe('SDK command caching', () => {
    it('should cache SDK commands after first successful fetch', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second trigger
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should only fetch once (cached)
      expect(getSdkCommands).toHaveBeenCalledTimes(1);

      dropdownWithSdk.destroy();
    });

    it('should retry fetch when previous result was empty', async () => {
      const getSdkCommands = jest.fn()
        .mockResolvedValueOnce([]) // First call returns empty
        .mockResolvedValueOnce(SDK_COMMANDS); // Second call returns commands

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger - gets empty result
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second trigger - should retry since previous was empty
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should fetch twice (retried because first was empty)
      expect(getSdkCommands).toHaveBeenCalledTimes(2);

      dropdownWithSdk.destroy();
    });

    it('should retry fetch when previous call threw error', async () => {
      const getSdkCommands = jest.fn()
        .mockRejectedValueOnce(new Error('SDK not ready'))
        .mockResolvedValueOnce(SDK_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger - throws error
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second trigger - should retry since previous threw
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should fetch twice (retried because first failed)
      expect(getSdkCommands).toHaveBeenCalledTimes(2);

      dropdownWithSdk.destroy();
    });
  });

  describe('race condition handling', () => {
    it('should discard stale results when newer request is made', async () => {
      let resolveFirst: (value: SlashCommand[]) => void;
      const firstPromise = new Promise<SlashCommand[]>(resolve => { resolveFirst = resolve; });

      const getSdkCommands = jest.fn()
        .mockReturnValueOnce(firstPromise)
        .mockResolvedValueOnce([
          { id: 'sdk:new', name: 'new-command', description: 'New', content: '', source: 'sdk' },
        ]);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger (will be slow)
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();

      // Second trigger (faster, should supersede first)
      inputEl.value = '/n';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Now resolve the first (stale) request
      resolveFirst!(SDK_COMMANDS);
      await new Promise(resolve => setTimeout(resolve, 10));

      // The cached commands should be from the second request, not the stale first
      const cachedSkills = (dropdownWithSdk as any).cachedSdkSkills as SlashCommand[];
      expect(cachedSkills.map(c => c.name)).toContain('new-command');
      // Should NOT have commands from stale first request
      expect(cachedSkills.map(c => c.name)).not.toContain('commit');

      dropdownWithSdk.destroy();
    });
  });

  describe('setHiddenCommands', () => {
    it('should update hidden commands set', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // Initial fetch with no hidden commands
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      let filteredCommands = (dropdownWithSdk as any).filteredCommands as SlashCommand[];
      expect(filteredCommands.map(c => c.name)).toContain('commit');

      // Now hide commit
      dropdownWithSdk.setHiddenCommands(new Set(['commit']));

      // Trigger again
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      filteredCommands = (dropdownWithSdk as any).filteredCommands as SlashCommand[];
      expect(filteredCommands.map(c => c.name)).not.toContain('commit');

      dropdownWithSdk.destroy();
    });
  });

  describe('resetSdkSkillsCache', () => {
    it('should clear cached SDK skills and allow refetch', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First fetch
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(getSdkCommands).toHaveBeenCalledTimes(1);

      // Reset cache
      dropdownWithSdk.resetSdkSkillsCache();

      // Trigger again - should refetch
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(getSdkCommands).toHaveBeenCalledTimes(2);

      dropdownWithSdk.destroy();
    });

    it('should reset requestId counter', () => {
      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks
      );

      // Increment requestId
      (dropdownWithSdk as any).requestId = 5;

      // Reset
      dropdownWithSdk.resetSdkSkillsCache();

      expect((dropdownWithSdk as any).requestId).toBe(0);

      dropdownWithSdk.destroy();
    });
  });

  describe('handleInputChange', () => {
    it('should hide dropdown when / is not at position 0', () => {
      inputEl.value = 'text /command';
      inputEl.selectionStart = 13;
      dropdown.handleInputChange();

      expect(callbacks.onHide).toHaveBeenCalled();
    });

    it('should hide dropdown when whitespace follows command', () => {
      inputEl.value = '/clear ';
      inputEl.selectionStart = 7;
      dropdown.handleInputChange();

      expect(callbacks.onHide).toHaveBeenCalled();
    });

    it('should show dropdown when / is at position 0', async () => {
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have created dropdown element
      expect(containerEl.children.length).toBeGreaterThan(0);
    });
  });

  describe('handleKeydown', () => {
    it('should return false when dropdown is not visible', () => {
      const event = { key: 'ArrowDown', preventDefault: jest.fn() } as any;
      const handled = dropdown.handleKeydown(event);

      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('isVisible', () => {
    it('should return false initially', () => {
      expect(dropdown.isVisible()).toBe(false);
    });
  });

  describe('hide', () => {
    it('should call onHide callback', () => {
      dropdown.hide();
      expect(callbacks.onHide).toHaveBeenCalled();
    });

    it('should reset slashStartIndex', () => {
      (dropdown as any).slashStartIndex = 5;
      dropdown.hide();
      expect((dropdown as any).slashStartIndex).toBe(-1);
    });
  });

  describe('destroy', () => {
    it('should remove input event listener', () => {
      dropdown.destroy();
      expect(inputEl.removeEventListener).toHaveBeenCalledWith('input', expect.any(Function));
    });
  });

  describe('search filtering', () => {
    it('should filter commands by name', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/com';
      inputEl.selectionStart = 4;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const filteredCommands = (dropdownWithSdk as any).filteredCommands as SlashCommand[];
      expect(filteredCommands.map(c => c.name)).toContain('commit');
      expect(filteredCommands.map(c => c.name)).not.toContain('pr');

      dropdownWithSdk.destroy();
    });

    it('should filter commands by description', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/pull';
      inputEl.selectionStart = 5;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const filteredCommands = (dropdownWithSdk as any).filteredCommands as SlashCommand[];
      // 'pr' has description 'Create a pull request'
      expect(filteredCommands.map(c => c.name)).toContain('pr');

      dropdownWithSdk.destroy();
    });

    it('should hide dropdown when search has no matches', async () => {
      inputEl.value = '/xyz123nonexistent';
      inputEl.selectionStart = 18;
      dropdown.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callbacks.onHide).toHaveBeenCalled();
    });

    it('should sort results alphabetically', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(SDK_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const filteredCommands = (dropdownWithSdk as any).filteredCommands as SlashCommand[];
      const names = filteredCommands.map(c => c.name);
      const sortedNames = [...names].sort();
      expect(names).toEqual(sortedNames);

      dropdownWithSdk.destroy();
    });
  });
});
