import { PluginManager } from '@/core/plugins/PluginManager';
import type { ClaudianPlugin } from '@/core/types';

// Create a mock PluginStorage
function createMockPluginStorage(plugins: ClaudianPlugin[] = []) {
  return {
    loadPlugins: jest.fn().mockReturnValue(plugins),
  } as any;
}

// Create a mock CCSettingsStorage
function createMockCCSettingsStorage(enabledPlugins: Record<string, boolean> = {}) {
  return {
    getEnabledPlugins: jest.fn().mockResolvedValue(enabledPlugins),
    setPluginEnabled: jest.fn().mockResolvedValue(undefined),
  } as any;
}

// Create a mock plugin
function createMockPlugin(overrides: Partial<ClaudianPlugin> = {}): ClaudianPlugin {
  return {
    id: 'test-plugin@marketplace',
    name: 'Test Plugin',
    description: 'A test plugin',
    version: '1.0.0',
    installPath: '/path/to/plugin',
    pluginPath: '/path/to/plugin/.claude-plugin',
    scope: 'user',
    enabled: false,
    status: 'available',
    ...overrides,
  };
}

describe('PluginManager', () => {
  describe('loadEnabledState', () => {
    it('loads enabled state from CC settings', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({
        'test-plugin@marketplace': true,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadPlugins();
      await manager.loadEnabledState();

      expect(ccSettings.getEnabledPlugins).toHaveBeenCalled();
      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(true);
    });

    it('enables plugins by default (not explicitly disabled)', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({}); // Empty = all enabled by default
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadPlugins();
      await manager.loadEnabledState();

      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(true);
    });

    it('disables plugins explicitly set to false', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({
        'test-plugin@marketplace': false,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadPlugins();
      await manager.loadEnabledState();

      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(false);
    });
  });

  describe('loadPlugins', () => {
    it('loads plugins from storage', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadPlugins();

      expect(pluginStorage.loadPlugins).toHaveBeenCalled();
      expect(manager.getPlugins()).toHaveLength(1);
    });

    it('applies enabled state from CC settings after load', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({
        'test-plugin@marketplace': false,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(false);
    });
  });

  describe('togglePlugin', () => {
    it('disables an enabled plugin', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      // Plugin is enabled by default
      expect(manager.getPlugins()[0].enabled).toBe(true);

      await manager.togglePlugin('test-plugin@marketplace');

      expect(manager.getPlugins()[0].enabled).toBe(false);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin@marketplace', false);
    });

    it('enables a disabled plugin', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({
        'test-plugin@marketplace': false,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      // Plugin is disabled
      expect(manager.getPlugins()[0].enabled).toBe(false);

      await manager.togglePlugin('test-plugin@marketplace');

      expect(manager.getPlugins()[0].enabled).toBe(true);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin@marketplace', true);
    });

    it('does nothing when plugin not found', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadPlugins();
      await manager.togglePlugin('nonexistent-plugin');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });

  describe('getPluginsKey', () => {
    it('returns empty string when no plugins are enabled', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({
        'test-plugin@marketplace': false,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      expect(manager.getPluginsKey()).toBe('');
    });

    it('returns stable key for active plugins', async () => {
      const plugins = [
        createMockPlugin({ id: 'plugin-b', pluginPath: '/path/b' }),
        createMockPlugin({ id: 'plugin-a', pluginPath: '/path/a' }),
      ];
      const pluginStorage = createMockPluginStorage(plugins);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      const key = manager.getPluginsKey();
      // Should be sorted alphabetically by ID
      expect(key).toBe('plugin-a:/path/a|plugin-b:/path/b');
    });

    it('excludes unavailable plugins from key', async () => {
      const plugins = [
        createMockPlugin({ id: 'available-plugin', status: 'available' }),
        createMockPlugin({ id: 'unavailable-plugin', status: 'unavailable' }),
      ];
      const pluginStorage = createMockPluginStorage(plugins);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      const key = manager.getPluginsKey();
      expect(key).not.toContain('unavailable-plugin');
      expect(key).toContain('available-plugin');
    });
  });

  describe('hasEnabledPlugins', () => {
    it('returns true when at least one plugin is enabled and available', async () => {
      const plugin = createMockPlugin({ status: 'available' });
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(true);
    });

    it('returns false when all enabled plugins are unavailable', async () => {
      const plugin = createMockPlugin({ status: 'unavailable' });
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(false);
    });
  });

  describe('hasPlugins', () => {
    it('returns true when plugins exist', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasPlugins()).toBe(true);
    });

    it('returns false when no plugins exist', async () => {
      const pluginStorage = createMockPluginStorage([]);
      const ccSettings = createMockCCSettingsStorage();
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadPlugins();

      expect(manager.hasPlugins()).toBe(false);
    });
  });

  describe('getPluginCommandPaths', () => {
    it('returns installPath for commands (not pluginPath)', async () => {
      const plugin = createMockPlugin({
        id: 'test-plugin',
        name: 'Test Plugin',
        installPath: '/path/to/plugin',
        pluginPath: '/path/to/plugin/.claude-plugin',
        status: 'available',
      });
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      const paths = manager.getPluginCommandPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0].pluginName).toBe('Test Plugin');
      // Commands are at {installPath}/commands/, not {pluginPath}/commands/
      expect(paths[0].commandsPath).toBe('/path/to/plugin');
    });

    it('excludes disabled and unavailable plugins', async () => {
      const plugins = [
        createMockPlugin({ id: 'enabled-available', status: 'available', installPath: '/path/a' }),
        createMockPlugin({ id: 'disabled-available', status: 'available', installPath: '/path/b' }),
        createMockPlugin({ id: 'enabled-unavailable', status: 'unavailable', installPath: '/path/c' }),
      ];
      const pluginStorage = createMockPluginStorage(plugins);
      const ccSettings = createMockCCSettingsStorage({
        'disabled-available': false,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      const paths = manager.getPluginCommandPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0].commandsPath).toBe('/path/a');
    });
  });

  describe('enablePlugin', () => {
    it('enables a disabled plugin', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({
        'test-plugin@marketplace': false,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      expect(manager.getPlugins()[0].enabled).toBe(false);

      await manager.enablePlugin('test-plugin@marketplace');

      expect(manager.getPlugins()[0].enabled).toBe(true);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin@marketplace', true);
    });

    it('does nothing if plugin is already enabled', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      await manager.enablePlugin('test-plugin@marketplace');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });

  describe('disablePlugin', () => {
    it('disables an enabled plugin', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({});
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      expect(manager.getPlugins()[0].enabled).toBe(true);

      await manager.disablePlugin('test-plugin@marketplace');

      expect(manager.getPlugins()[0].enabled).toBe(false);
      expect(ccSettings.setPluginEnabled).toHaveBeenCalledWith('test-plugin@marketplace', false);
    });

    it('does nothing if plugin is already disabled', async () => {
      const plugin = createMockPlugin();
      const pluginStorage = createMockPluginStorage([plugin]);
      const ccSettings = createMockCCSettingsStorage({
        'test-plugin@marketplace': false,
      });
      const manager = new PluginManager(pluginStorage, ccSettings);

      await manager.loadEnabledState();
      await manager.loadPlugins();

      await manager.disablePlugin('test-plugin@marketplace');

      expect(ccSettings.setPluginEnabled).not.toHaveBeenCalled();
    });
  });
});
