import * as fs from 'fs';
import * as path from 'path';

const homeDir = '/Users/testuser';

// Mock os.homedir before any module imports
jest.mock('os', () => ({
  homedir: jest.fn(() => homeDir),
}));

// Mock fs module
jest.mock('fs');

import { PluginStorage } from '@/core/plugins/PluginStorage';

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
  });
});
