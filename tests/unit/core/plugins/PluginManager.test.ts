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
function createMockCCSettingsStorage(enabledPlugins: Record<string, boolean> = {}) {
  return {
    getEnabledPlugins: jest.fn().mockResolvedValue(enabledPlugins),
    setPluginEnabled: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('PluginManager', () => {
  const globalSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  const projectSettingsPath = path.join(vaultPath, '.claude', 'settings.json');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadPlugins', () => {
    it('returns empty array when no settings files exist', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.getPlugins()).toEqual([]);
    });

    it('loads plugins from global settings', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin@marketplace': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].id).toBe('test-plugin@marketplace');
      expect(plugins[0].enabled).toBe(true);
      expect(plugins[0].scope).toBe('user');
    });

    it('loads plugins from project settings', async () => {
      const projectSettings = {
        enabledPlugins: { 'project-plugin@marketplace': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === projectSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(projectSettings));

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].id).toBe('project-plugin@marketplace');
      expect(plugins[0].enabled).toBe(true);
      expect(plugins[0].scope).toBe('project');
    });

    it('merges plugins from both global and project settings', async () => {
      const globalSettings = {
        enabledPlugins: { 'plugin-a': true, 'plugin-b': true },
      };
      const projectSettings = {
        enabledPlugins: { 'plugin-c': true },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        if (String(p) === projectSettingsPath) return JSON.stringify(projectSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins.length).toBe(3);

      // Project plugins first
      expect(plugins[0].id).toBe('plugin-c');
      expect(plugins[0].scope).toBe('project');

      // Then user plugins (sorted alphabetically)
      expect(plugins[1].id).toBe('plugin-a');
      expect(plugins[1].scope).toBe('user');
      expect(plugins[2].id).toBe('plugin-b');
      expect(plugins[2].scope).toBe('user');
    });

    it('project false overrides global true', async () => {
      const globalSettings = {
        enabledPlugins: { 'plugin-a': true, 'plugin-b': true },
      };
      const projectSettings = {
        enabledPlugins: { 'plugin-b': false, 'plugin-c': true },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === globalSettingsPath) return JSON.stringify(globalSettings);
        if (String(p) === projectSettingsPath) return JSON.stringify(projectSettings);
        return '{}';
      });

      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const plugins = manager.getPlugins();

      const pluginB = plugins.find(p => p.id === 'plugin-b');
      expect(pluginB).toBeDefined();
      expect(pluginB!.enabled).toBe(false);
      expect(pluginB!.scope).toBe('project'); // Project scope because it's in project settings

      const pluginC = plugins.find(p => p.id === 'plugin-c');
      expect(pluginC!.enabled).toBe(true);
      expect(pluginC!.scope).toBe('project');

      const pluginA = plugins.find(p => p.id === 'plugin-a');
      expect(pluginA!.enabled).toBe(true);
      expect(pluginA!.scope).toBe('user');
    });
  });

  describe('togglePlugin', () => {
    it('disables an enabled plugin', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      expect(manager.getPlugins()[0].enabled).toBe(true);

      await manager.togglePlugin('test-plugin');

      expect(manager.getPlugins()[0].enabled).toBe(false);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin', false);
    });

    it('enables a disabled plugin', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': false },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      expect(manager.getPlugins()[0].enabled).toBe(false);

      await manager.togglePlugin('test-plugin');

      expect(manager.getPlugins()[0].enabled).toBe(true);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin', true);
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
      const globalSettings = {
        enabledPlugins: { 'test-plugin': false },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.getPluginsKey()).toBe('');
    });

    it('returns stable key for enabled plugins', async () => {
      const globalSettings = {
        enabledPlugins: { 'plugin-b': true, 'plugin-a': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      const key = manager.getPluginsKey();
      // Should be sorted alphabetically by ID
      expect(key).toBe('plugin-a|plugin-b');
    });
  });

  describe('hasEnabledPlugins', () => {
    it('returns true when at least one plugin is enabled', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(true);
    });

    it('returns false when all plugins are disabled', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': false },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(false);
    });
  });

  describe('hasPlugins', () => {
    it('returns true when plugins exist', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
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

  describe('enablePlugin', () => {
    it('enables a disabled plugin', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': false },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      expect(manager.getPlugins()[0].enabled).toBe(false);

      await manager.enablePlugin('test-plugin');

      expect(manager.getPlugins()[0].enabled).toBe(true);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin', true);
    });

    it('does nothing if plugin is already enabled', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      await manager.enablePlugin('test-plugin');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });

  describe('disablePlugin', () => {
    it('disables an enabled plugin', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': true },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();
      expect(manager.getPlugins()[0].enabled).toBe(true);

      await manager.disablePlugin('test-plugin');

      expect(manager.getPlugins()[0].enabled).toBe(false);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin', false);
    });

    it('does nothing if plugin is already disabled', async () => {
      const globalSettings = {
        enabledPlugins: { 'test-plugin': false },
      };

      mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === globalSettingsPath;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify(globalSettings));

      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(vaultPath, ccSettings);

      await manager.loadPlugins();

      await manager.disablePlugin('test-plugin');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });
});
