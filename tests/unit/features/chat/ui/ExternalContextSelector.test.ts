/**
 * Tests for ExternalContextSelector - Persistent External Context Paths
 */

import * as fs from 'fs';

import { ExternalContextSelector } from '@/features/chat/ui/InputToolbar';

// Mock obsidian
jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

// Mock fs
jest.mock('fs');

// Helper to create mock DOM element
type EventHandler = (...args: unknown[]) => unknown;

function createMockElement(): any {
  const children: any[] = [];
  const classList = new Set<string>();
  const attributes: Record<string, string> = {};
  const eventListeners: Record<string, EventHandler[]> = {};

  const el: any = {
    empty: jest.fn(() => { children.length = 0; }),
    createDiv: jest.fn((opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.classList.add(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    }),
    createSpan: jest.fn((opts?: { cls?: string; text?: string }) => {
      const child = createMockElement();
      if (opts?.cls) child.classList.add(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    }),
    addClass: jest.fn((cls: string) => classList.add(cls)),
    removeClass: jest.fn((cls: string) => classList.delete(cls)),
    hasClass: (cls: string) => classList.has(cls),
    classList: {
      add: (cls: string) => classList.add(cls),
      remove: (cls: string) => classList.delete(cls),
      contains: (cls: string) => classList.has(cls),
    },
    setAttribute: jest.fn((key: string, value: string) => { attributes[key] = value; }),
    getAttribute: (key: string) => attributes[key],
    addEventListener: jest.fn((event: string, handler: EventHandler) => {
      if (!eventListeners[event]) eventListeners[event] = [];
      eventListeners[event].push(handler);
    }),
    setText: jest.fn((text: string) => { el.textContent = text; }),
    textContent: '',
    style: {},
    children,
  };

  return el;
}

// Mock callbacks
function createMockCallbacks() {
  return {
    onModelChange: jest.fn(),
    onThinkingBudgetChange: jest.fn(),
    onPermissionModeChange: jest.fn(),
    getSettings: jest.fn().mockReturnValue({
      model: 'haiku',
      thinkingBudget: 'off',
      permissionMode: 'yolo',
    }),
    getEnvironmentVariables: jest.fn().mockReturnValue(''),
  };
}

describe('ExternalContextSelector', () => {
  let parentEl: any;
  let selector: ExternalContextSelector;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    jest.clearAllMocks();
    // By default, all paths are valid (exist on filesystem)
    (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });
    parentEl = createMockElement();
    callbacks = createMockCallbacks();
    selector = new ExternalContextSelector(parentEl, callbacks);
  });

  describe('Persistent Paths Management', () => {
    it('should initialize with empty persistent paths', () => {
      expect(selector.getPersistentPaths()).toEqual([]);
    });

    it('should set persistent paths from settings', () => {
      selector.setPersistentPaths(['/path/a', '/path/b']);

      expect(selector.getPersistentPaths()).toEqual(['/path/a', '/path/b']);
    });

    it('should merge persistent paths into external contexts when setting', () => {
      selector.setPersistentPaths(['/path/a', '/path/b']);

      // After setting persistent paths, they should be in external contexts
      expect(selector.getExternalContexts()).toContain('/path/a');
      expect(selector.getExternalContexts()).toContain('/path/b');
    });

    it('should toggle persistence on - add path to persistent paths', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      // First set some external context paths
      selector.setExternalContexts(['/path/a']);

      // Toggle persistence on for path/a
      selector.togglePersistence('/path/a');

      expect(selector.getPersistentPaths()).toContain('/path/a');
      expect(onPersistenceChange).toHaveBeenCalledWith(['/path/a']);
    });

    it('should toggle persistence off - remove path from persistent paths', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      // Set up with a persistent path
      selector.setPersistentPaths(['/path/a']);

      // Toggle persistence off
      selector.togglePersistence('/path/a');

      expect(selector.getPersistentPaths()).not.toContain('/path/a');
      expect(onPersistenceChange).toHaveBeenCalledWith([]);
    });

    it('should handle multiple persistent paths', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      selector.setPersistentPaths(['/path/a']);
      selector.togglePersistence('/path/b');

      expect(selector.getPersistentPaths()).toContain('/path/a');
      expect(selector.getPersistentPaths()).toContain('/path/b');
      expect(onPersistenceChange).toHaveBeenCalledWith(
        expect.arrayContaining(['/path/a', '/path/b'])
      );
    });
  });

  describe('clearExternalContexts', () => {
    it('should reset to persistent paths when called without parameter', () => {
      selector.setPersistentPaths(['/persistent/path']);
      selector.setExternalContexts(['/session/path', '/persistent/path']);

      selector.clearExternalContexts();

      expect(selector.getExternalContexts()).toEqual(['/persistent/path']);
    });

    it('should use provided paths when called with parameter', () => {
      selector.setPersistentPaths(['/old/path']);

      selector.clearExternalContexts(['/new/path/a', '/new/path/b']);

      expect(selector.getExternalContexts()).toEqual(['/new/path/a', '/new/path/b']);
      expect(selector.getPersistentPaths()).toEqual(['/new/path/a', '/new/path/b']);
    });

    it('should update persistentPaths when called with parameter', () => {
      selector.setPersistentPaths(['/old/path']);

      selector.clearExternalContexts(['/new/path']);

      // Local persistentPaths should be updated
      expect(selector.getPersistentPaths()).toEqual(['/new/path']);
    });
  });

  describe('setExternalContexts', () => {
    it('should set exact paths without merging persistent paths', () => {
      selector.setPersistentPaths(['/persistent/path']);

      selector.setExternalContexts(['/session/path']);

      // Should only have the session path, not merged with persistent
      expect(selector.getExternalContexts()).toEqual(['/session/path']);
    });

    it('should not modify persistent paths', () => {
      selector.setPersistentPaths(['/persistent/path']);

      selector.setExternalContexts(['/session/path']);

      // Persistent paths should remain unchanged
      expect(selector.getPersistentPaths()).toEqual(['/persistent/path']);
    });

    it('should handle empty array', () => {
      selector.setPersistentPaths(['/persistent/path']);
      selector.setExternalContexts(['/session/path']);

      selector.setExternalContexts([]);

      expect(selector.getExternalContexts()).toEqual([]);
      expect(selector.getPersistentPaths()).toEqual(['/persistent/path']);
    });
  });

  describe('Callbacks', () => {
    it('should call onChange when paths are removed via removePath', () => {
      const onChange = jest.fn();
      selector.setOnChange(onChange);

      selector.setExternalContexts(['/path/a', '/path/b']);
      selector.removePath('/path/a');

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(['/path/b']);
    });

    it('should call onPersistenceChange when persistence is toggled', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      selector.setExternalContexts(['/path/a']);
      selector.togglePersistence('/path/a');

      expect(onPersistenceChange).toHaveBeenCalledTimes(1);
      expect(onPersistenceChange).toHaveBeenCalledWith(['/path/a']);
    });
  })

  describe('removePath', () => {
    it('should remove path from external contexts', () => {
      selector.setExternalContexts(['/path/a', '/path/b']);

      selector.removePath('/path/a');

      expect(selector.getExternalContexts()).toEqual(['/path/b']);
    });

    it('should remove path from persistent paths if it was persistent', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      selector.setPersistentPaths(['/path/a', '/path/b']);

      selector.removePath('/path/a');

      expect(selector.getPersistentPaths()).toEqual(['/path/b']);
      expect(selector.getExternalContexts()).toEqual(['/path/b']);
      expect(onPersistenceChange).toHaveBeenCalledWith(['/path/b']);
    });

    it('should not call onPersistenceChange when removing non-persistent path', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      selector.setPersistentPaths(['/path/a']);
      selector.setExternalContexts(['/path/a', '/path/b']);

      // Clear mock calls from setPersistentPaths
      onPersistenceChange.mockClear();

      selector.removePath('/path/b');

      expect(selector.getExternalContexts()).toEqual(['/path/a']);
      expect(onPersistenceChange).not.toHaveBeenCalled();
    });

    it('should call onChange callback when removing path', () => {
      const onChange = jest.fn();
      selector.setOnChange(onChange);

      selector.setExternalContexts(['/path/a', '/path/b']);
      selector.removePath('/path/a');

      expect(onChange).toHaveBeenCalledWith(['/path/b']);
    });
  });

  describe('Edge Cases', () => {
    it('should handle duplicate paths in setPersistentPaths', () => {
      // All paths are valid for this test
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });

      selector.setPersistentPaths(['/path/a', '/path/a', '/path/b']);

      // Set uses deduplication
      const paths = selector.getPersistentPaths();
      expect(paths.filter(p => p === '/path/a').length).toBe(1);
    });

    it('should handle toggling same path multiple times', () => {
      // All paths are valid for this test
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });

      selector.setExternalContexts(['/path/a']);

      // Toggle on
      selector.togglePersistence('/path/a');
      expect(selector.getPersistentPaths()).toContain('/path/a');

      // Toggle off
      selector.togglePersistence('/path/a');
      expect(selector.getPersistentPaths()).not.toContain('/path/a');

      // Toggle on again
      selector.togglePersistence('/path/a');
      expect(selector.getPersistentPaths()).toContain('/path/a');
    });

    it('should preserve persistent paths across setExternalContexts calls', () => {
      // All paths are valid for this test
      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });

      selector.setPersistentPaths(['/persistent/path']);

      selector.setExternalContexts(['/session1']);
      selector.setExternalContexts(['/session2']);
      selector.setExternalContexts([]);

      // Persistent paths should remain unchanged
      expect(selector.getPersistentPaths()).toEqual(['/persistent/path']);
    });
  });

  describe('Path Validation', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should filter out invalid paths on setPersistentPaths (app load)', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      // Mock: /valid/path exists, /invalid/path does not
      (fs.statSync as jest.Mock).mockImplementation((p: string) => {
        if (p === '/valid/path') {
          return { isDirectory: () => true };
        }
        throw new Error('ENOENT');
      });

      selector.setPersistentPaths(['/valid/path', '/invalid/path']);

      // Should only have the valid path
      expect(selector.getPersistentPaths()).toEqual(['/valid/path']);
      expect(selector.getExternalContexts()).toEqual(['/valid/path']);

      // Should save the updated list since invalid paths were removed
      expect(onPersistenceChange).toHaveBeenCalledWith(['/valid/path']);
    });

    it('should not call onPersistenceChange when all paths are valid', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });

      selector.setPersistentPaths(['/path/a', '/path/b']);

      // All paths valid, no need to save
      expect(onPersistenceChange).not.toHaveBeenCalled();
      expect(selector.getPersistentPaths()).toEqual(['/path/a', '/path/b']);
    });

    it('should handle all paths being invalid', () => {
      const onPersistenceChange = jest.fn();
      selector.setOnPersistenceChange(onPersistenceChange);

      (fs.statSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      selector.setPersistentPaths(['/invalid/a', '/invalid/b']);

      expect(selector.getPersistentPaths()).toEqual([]);
      expect(selector.getExternalContexts()).toEqual([]);
      expect(onPersistenceChange).toHaveBeenCalledWith([]);
    });
  });
});
