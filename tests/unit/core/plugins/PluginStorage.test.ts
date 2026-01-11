import * as fs from 'fs';
import * as path from 'path';

const homeDir = '/Users/testuser';

// Mock os.homedir before any module imports
jest.mock('os', () => ({
  homedir: jest.fn(() => homeDir),
}));

// Mock fs module
jest.mock('fs');

import { loadPluginCommands,PluginStorage } from '@/core/plugins/PluginStorage';

const mockFs = fs as jest.Mocked<typeof fs>;

describe('PluginStorage', () => {
  const vaultPath = '/Users/testuser/Documents/vault';
  const installedPluginsPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadPlugins', () => {
    it('returns empty array when installed_plugins.json does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins).toEqual([]);
    });

    it('returns empty array when JSON is invalid', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins).toEqual([]);
    });

    it('loads user-scoped plugins (projectPath = home directory)', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'test-plugin@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/test-plugin',
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.includes('.claude-plugin')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(1);
      expect(plugins[0].scope).toBe('user');
      expect(plugins[0].id).toBe('test-plugin@marketplace');
    });

    it('includes project-scoped plugins matching current vault', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'project-plugin@marketplace': [
            {
              scope: 'project',
              projectPath: vaultPath,
              installPath: path.join(vaultPath, '.claude/plugins/project-plugin'),
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.includes('.claude-plugin')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(1);
      expect(plugins[0].scope).toBe('project');
    });

    it('excludes project-scoped plugins not matching current vault', () => {
      const otherVaultPath = '/Users/testuser/Documents/other-vault';
      const installedPlugins = {
        version: 1,
        plugins: {
          'project-plugin@marketplace': [
            {
              scope: 'project',
              projectPath: otherVaultPath,
              installPath: path.join(otherVaultPath, '.claude/plugins/project-plugin'),
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(0);
    });

    it('picks newest entry when multiple entries exist', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'test-plugin@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/test-plugin-old',
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/test-plugin-new',
              version: '2.0.0',
              installedAt: '2024-06-01T00:00:00Z',
              lastUpdated: '2024-06-15T00:00:00Z',
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.includes('.claude-plugin')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(1);
      expect(plugins[0].version).toBe('2.0.0');
      expect(plugins[0].installPath).toContain('test-plugin-new');
    });

    it('prefers higher semantic version when timestamps are equal', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'test-plugin@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/test-plugin-v2',
              version: '2.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/test-plugin-v10',
              version: '10.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.endsWith('.claude-plugin')) return true;
        if (pathStr.includes('test-plugin-v2') || pathStr.includes('test-plugin-v10')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(1);
      expect(plugins[0].version).toBe('10.0.0');
      expect(plugins[0].installPath).toContain('test-plugin-v10');
    });

    it('marks plugin as unavailable when install path does not exist', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'missing-plugin@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/nonexistent/path',
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        // Install path and .claude-plugin dir don't exist
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(1);
      expect(plugins[0].status).toBe('unavailable');
      expect(plugins[0].error).toBe('Plugin directory not found');
    });

    it('sorts plugins: project/local first, then user', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'user-plugin@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/user-plugin',
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
          'project-plugin@marketplace': [
            {
              scope: 'project',
              projectPath: vaultPath,
              installPath: path.join(vaultPath, '.claude/plugins/project-plugin'),
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.includes('.claude-plugin')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(2);
      // Project plugins should come first
      expect(plugins[0].scope).toBe('project');
      expect(plugins[1].scope).toBe('user');
    });

    it('filters out invalid plugin entries', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'valid-plugin@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/valid-plugin',
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
            // Invalid entry - missing required fields
            {
              scope: 'user',
              projectPath: homeDir,
              // Missing installPath, version, installedAt
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.includes('.claude-plugin')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      // Should only load the valid entry
      expect(plugins.length).toBe(1);
      expect(plugins[0].version).toBe('1.0.0');
    });

    it('loads plugin from marketplace.json manifest', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'code-review@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/code-review',
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      const marketplaceManifest = {
        plugins: [
          {
            name: 'Code Review',
            description: 'Code review plugin',
            source: 'code-review-src',
          },
        ],
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.endsWith('.claude-plugin')) return true;
        if (pathStr.endsWith('marketplace.json')) return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (pathStr.endsWith('marketplace.json')) return JSON.stringify(marketplaceManifest);
        return '';
      });

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(1);
      expect(plugins[0].name).toBe('Code Review');
      expect(plugins[0].description).toBe('Code review plugin');
      expect(plugins[0].pluginPath).toContain('code-review-src');
    });

    it('falls back to first plugin when no name match in marketplace.json', () => {
      const installedPlugins = {
        version: 1,
        plugins: {
          'unknown-plugin@marketplace': [
            {
              scope: 'user',
              projectPath: homeDir,
              installPath: '/Users/testuser/.claude/plugins/unknown',
              version: '1.0.0',
              installedAt: '2024-01-01T00:00:00Z',
            },
          ],
        },
      };

      const marketplaceManifest = {
        plugins: [
          {
            name: 'First Plugin',
            description: 'First plugin in marketplace',
          },
          {
            name: 'Second Plugin',
            description: 'Second plugin',
          },
        ],
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return true;
        if (pathStr.endsWith('.claude-plugin')) return true;
        if (pathStr.endsWith('marketplace.json')) return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const pathStr = String(p);
        if (pathStr === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (pathStr.endsWith('marketplace.json')) return JSON.stringify(marketplaceManifest);
        return '';
      });

      const storage = new PluginStorage(vaultPath);
      const plugins = storage.loadPlugins();

      expect(plugins.length).toBe(1);
      expect(plugins[0].name).toBe('First Plugin');
    });
  });

  describe('loadPluginCommands', () => {
    // Helper to create mock Dirent objects
    const createMockDirent = (name: string, isDir: boolean): fs.Dirent => ({
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      path: '',
      parentPath: '',
    });

    it('returns empty array when commands directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const commands = loadPluginCommands('/path/to/plugin', 'Test Plugin');

      expect(commands).toEqual([]);
    });

    it('loads commands from markdown files in commands directory', () => {
      const commandContent = `---
description: Run tests
---
Run all tests in the project`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([createMockDirent('test.md', false)] as any);
      mockFs.readFileSync.mockReturnValue(commandContent);

      const commands = loadPluginCommands('/path/to/plugin', 'Test Plugin');

      expect(commands.length).toBe(1);
      expect(commands[0].name).toBe('test-plugin:test');
      expect(commands[0].description).toBe('Run tests');
      expect(commands[0].content).toBe('Run all tests in the project');
    });

    it('namespaces commands with plugin name (lowercase, hyphenated)', () => {
      const commandContent = `---
description: A command
---
Command content`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([createMockDirent('my-command.md', false)] as any);
      mockFs.readFileSync.mockReturnValue(commandContent);

      const commands = loadPluginCommands('/path/to/plugin', 'Code Review Tool');

      expect(commands.length).toBe(1);
      expect(commands[0].name).toBe('code-review-tool:my-command');
    });

    it('handles nested subdirectories correctly', () => {
      const commandContent = `---
description: Nested command
---
Content`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockImplementation((dir) => {
        const dirStr = String(dir);
        if (dirStr.endsWith('commands')) {
          return [createMockDirent('subdir', true)] as any;
        }
        if (dirStr.endsWith('subdir')) {
          return [createMockDirent('nested.md', false)] as any;
        }
        return [];
      });
      mockFs.readFileSync.mockReturnValue(commandContent);

      const commands = loadPluginCommands('/path/to/plugin', 'Test Plugin');

      expect(commands.length).toBe(1);
      expect(commands[0].name).toBe('test-plugin:subdir/nested');
    });

    it('skips invalid markdown files gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        createMockDirent('valid.md', false),
        createMockDirent('invalid.md', false),
      ] as any);

      let callCount = 0;
      mockFs.readFileSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call (valid.md)
          return `---
description: Valid command
---
Content`;
        }
        // Second call (invalid.md) - throw error
        throw new Error('Read error');
      });

      const commands = loadPluginCommands('/path/to/plugin', 'Test Plugin');

      // Should only load the valid command
      expect(commands.length).toBe(1);
      expect(commands[0].name).toBe('test-plugin:valid');
    });

    it('generates stable unique IDs with proper escaping', () => {
      const commandContent = `---
description: A command
---
Content`;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([createMockDirent('my-cmd.md', false)] as any);
      mockFs.readFileSync.mockReturnValue(commandContent);

      const commands = loadPluginCommands('/path/to/plugin', 'test-plugin');

      expect(commands.length).toBe(1);
      // ID should escape - as -_ and : as --
      expect(commands[0].id).toBe('plugin-test-_plugin--my-_cmd');
    });
  });
});
