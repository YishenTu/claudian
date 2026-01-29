import * as fs from 'fs';
import * as path from 'path';

const homeDir = '/Users/testuser';
const vaultPath = '/Users/testuser/Documents/vault';

// Mock os.homedir before any module imports
jest.mock('os', () => ({
  homedir: jest.fn(() => homeDir),
}));

// Mock fs module
jest.mock('fs');

import { PluginManager } from '@/core/plugins/PluginManager';

const mockFs = fs as jest.Mocked<typeof fs>;

// Create a mock CCSettingsStorage
function createMockCCSettingsStorage() {
  return {
    getEnabledPlugins: jest.fn().mockResolvedValue({}),
    setPluginEnabled: jest.fn().mockResolvedValue(undefined),
  } as any;
}

const installedPluginsPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
const globalSettingsPath = path.join(homeDir, '.claude', 'settings.json');
const projectSettingsPath = path.join(vaultPath, '.claude', 'settings.json');

describe('PluginManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadPlugins', () => {
    it('returns empty array when no installed_plugins.json exists', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.getPlugins()).toEqual([]);
    });

    it('loads plugins from installed_plugins.json with enabled state from settings', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };
      const globalSettings = {
        enabledPlugins: { 'test-plugin@marketplace': true },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].id).toBe('test-plugin@marketplace');
      expect(plugins[0].name).toBe('test-plugin');
      expect(plugins[0].enabled).toBe(true);
      expect(plugins[0].scope).toBe('user');
      expect(plugins[0].installPath).toBe('/path/to/test-plugin');
    });

    it('defaults to enabled for installed plugins not in settings', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'new-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/new-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].enabled).toBe(true); // Default to enabled
    });

    it('project false overrides global true', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'plugin-a@marketplace': [{
            scope: 'user',
            installPath: '/path/to/plugin-a',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };
      const globalSettings = {
        enabledPlugins: { 'plugin-a@marketplace': true },
      };
      const projectSettings = {
        enabledPlugins: { 'plugin-a@marketplace': false },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        if (String(p) === projectSettingsPath) return JSON.stringify(projectSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(false);
      expect(plugins[0].scope).toBe('user'); // Scope reflects installation, not settings location
    });

    it('extracts plugin name from ID correctly', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'feature-dev@claude-plugins-official': [{
            scope: 'user',
            installPath: '/path/to/feature-dev',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins[0].name).toBe('feature-dev');
    });

    it('sorts plugins: project first, then user', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'user-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/user-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
          'project-plugin@marketplace': [{
            scope: 'project',
            installPath: '/path/to/project-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
            projectPath: vaultPath,
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(2);
      expect(plugins[0].scope).toBe('project');
      expect(plugins[1].scope).toBe('user');
    });

    it('excludes project plugins installed for other vaults', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'other-project-plugin@marketplace': [{
            scope: 'project',
            installPath: '/path/to/other-project-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
            projectPath: '/Users/testuser/Documents/other-vault',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.getPlugins()).toEqual([]);
    });

    it('prefers project plugin entry for the current vault', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'multi-scope-plugin@marketplace': [
            {
              scope: 'user',
              installPath: '/path/to/user-install',
              version: '1.0.0',
              installedAt: '2026-01-01T00:00:00.000Z',
              lastUpdated: '2026-01-01T00:00:00.000Z',
            },
            {
              scope: 'project',
              installPath: '/path/to/project-install',
              version: '1.0.0',
              installedAt: '2026-01-01T00:00:00.000Z',
              lastUpdated: '2026-01-01T00:00:00.000Z',
              projectPath: vaultPath,
            },
          ],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].scope).toBe('project');
      expect(plugins[0].installPath).toBe('/path/to/project-install');
    });
  });

  describe('togglePlugin', () => {
    it('disables an enabled plugin', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      expect(manager.getPlugins()[0].enabled).toBe(true);

      await manager.togglePlugin('test-plugin@marketplace');

      expect(manager.getPlugins()[0].enabled).toBe(false);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin@marketplace', false);
    });

    it('does nothing when plugin not found', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      await manager.togglePlugin('nonexistent-plugin');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });

  describe('getPluginsKey', () => {
    it('returns empty string when no plugins are enabled', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };
      const globalSettings = {
        enabledPlugins: { 'test-plugin@marketplace': false },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.getPluginsKey()).toBe('');
    });

    it('returns stable key for enabled plugins', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'plugin-b@marketplace': [{
            scope: 'user',
            installPath: '/path/to/plugin-b',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
          'plugin-a@marketplace': [{
            scope: 'user',
            installPath: '/path/to/plugin-a',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const key = manager.getPluginsKey();
      // Should be sorted alphabetically by ID
      expect(key).toBe('plugin-a@marketplace:/path/to/plugin-a|plugin-b@marketplace:/path/to/plugin-b');
    });
  });

  describe('hasEnabledPlugins', () => {
    it('returns true when at least one plugin is enabled', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(true);
    });

    it('returns false when all plugins are disabled', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };
      const globalSettings = {
        enabledPlugins: { 'test-plugin@marketplace': false },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(false);
    });
  });

  describe('enablePlugin', () => {
    it('enables a disabled plugin', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };
      const globalSettings = {
        enabledPlugins: { 'test-plugin@marketplace': false },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      expect(manager.getPlugins()[0].enabled).toBe(false);

      await manager.enablePlugin('test-plugin@marketplace');

      expect(manager.getPlugins()[0].enabled).toBe(true);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin@marketplace', true);
    });

    it('does nothing when plugin is already enabled', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      await manager.enablePlugin('test-plugin@marketplace');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });

    it('does nothing for nonexistent plugin', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      await manager.enablePlugin('nonexistent');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });

  describe('disablePlugin', () => {
    it('disables an enabled plugin', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      expect(manager.getPlugins()[0].enabled).toBe(true);

      await manager.disablePlugin('test-plugin@marketplace');

      expect(manager.getPlugins()[0].enabled).toBe(false);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin@marketplace', false);
    });

    it('does nothing when plugin is already disabled', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };
      const globalSettings = {
        enabledPlugins: { 'test-plugin@marketplace': false },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      await manager.disablePlugin('test-plugin@marketplace');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });

    it('does nothing for nonexistent plugin', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      await manager.disablePlugin('nonexistent');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });

  describe('getEnabledCount', () => {
    it('returns count of enabled plugins', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'plugin-a@marketplace': [{
            scope: 'user',
            installPath: '/path/to/a',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
          'plugin-b@marketplace': [{
            scope: 'user',
            installPath: '/path/to/b',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };
      const globalSettings = {
        enabledPlugins: {
          'plugin-a@marketplace': true,
          'plugin-b@marketplace': false,
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === installedPluginsPath) return JSON.stringify(installedPlugins);
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.getEnabledCount()).toBe(1);
    });

    it('returns 0 when no plugins loaded', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.getEnabledCount()).toBe(0);
    });
  });

  describe('hasPlugins', () => {
    it('returns true when plugins exist', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'test-plugin@marketplace': [{
            scope: 'user',
            installPath: '/path/to/test-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasPlugins()).toBe(true);
    });

    it('returns false when no plugins exist', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasPlugins()).toBe(false);
    });
  });

  describe('readJsonFile error handling', () => {
    it('returns null when JSON parse fails', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('not valid json {{{');

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      // Should gracefully handle parse error and return empty plugins
      expect(manager.getPlugins()).toEqual([]);
    });
  });

  describe('extractPluginName without @', () => {
    it('returns full ID when no @ is present', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'simple-plugin': [{
            scope: 'user' as const,
            installPath: '/path/to/simple-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].name).toBe('simple-plugin');
      expect(plugins[0].id).toBe('simple-plugin');
    });
  });

  describe('normalizePathForComparison', () => {
    it('uses realpathSync when available', async () => {
      const installedPlugins = {
        version: 2,
        plugins: {
          'project-plugin@marketplace': [{
            scope: 'project' as const,
            installPath: '/path/to/project-plugin',
            version: '1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
            projectPath: vaultPath,
          }],
        },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === installedPluginsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(installedPlugins));
      // realpathSync returns the resolved path
      mockFs.realpathSync.mockReturnValue(vaultPath);

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].scope).toBe('project');
    });
  });
});
