import { PluginManager } from '@/core/plugins/PluginManager';
import type { ClaudianPlugin } from '@/core/types';

// Create a mock PluginStorage
function createMockStorage(plugins: ClaudianPlugin[] = []) {
  return {
    loadPlugins: jest.fn().mockReturnValue(plugins),
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
  describe('setEnabledPluginIds', () => {
    it('sets enabled state for plugins', async () => {
      const plugin = createMockPlugin();
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();
      manager.setEnabledPluginIds(['test-plugin@marketplace']);

      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(true);
    });

    it('disables plugins not in the list', async () => {
      const plugin = createMockPlugin({ enabled: true });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['test-plugin@marketplace']);
      await manager.loadPlugins();
      manager.setEnabledPluginIds([]);

      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(false);
    });
  });

  describe('loadPlugins', () => {
    it('loads plugins from storage', async () => {
      const plugin = createMockPlugin();
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();

      expect(storage.loadPlugins).toHaveBeenCalled();
      expect(manager.getPlugins()).toHaveLength(1);
    });

    it('applies enabled state from previously set IDs', async () => {
      const plugin = createMockPlugin();
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['test-plugin@marketplace']);
      await manager.loadPlugins();

      const plugins = manager.getPlugins();
      expect(plugins[0].enabled).toBe(true);
    });
  });

  describe('getActivePluginConfigs', () => {
    it('returns configs only for enabled and available plugins', async () => {
      const plugins = [
        createMockPlugin({ id: 'enabled-plugin', enabled: true, status: 'available' }),
        createMockPlugin({ id: 'disabled-plugin', enabled: false, status: 'available' }),
        createMockPlugin({ id: 'unavailable-plugin', enabled: true, status: 'unavailable' }),
      ];
      const storage = createMockStorage(plugins);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();
      manager.setEnabledPluginIds(['enabled-plugin', 'unavailable-plugin']);

      const configs = manager.getActivePluginConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0].type).toBe('local');
      expect(configs[0].path).toBe('/path/to/plugin/.claude-plugin');
    });

    it('returns empty array when no plugins are enabled', async () => {
      const plugin = createMockPlugin({ enabled: false });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();

      const configs = manager.getActivePluginConfigs();
      expect(configs).toHaveLength(0);
    });
  });

  describe('getUnavailableEnabledPlugins', () => {
    it('returns IDs of enabled but unavailable plugins', async () => {
      const plugins = [
        createMockPlugin({ id: 'available-plugin', enabled: true, status: 'available' }),
        createMockPlugin({ id: 'unavailable-plugin', enabled: true, status: 'unavailable' }),
        createMockPlugin({ id: 'invalid-plugin', enabled: true, status: 'invalid-manifest' }),
      ];
      const storage = createMockStorage(plugins);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();
      manager.setEnabledPluginIds(['available-plugin', 'unavailable-plugin', 'invalid-plugin']);

      const unavailable = manager.getUnavailableEnabledPlugins();
      expect(unavailable).toHaveLength(2);
      expect(unavailable).toContain('unavailable-plugin');
      expect(unavailable).toContain('invalid-plugin');
    });
  });

  describe('togglePlugin', () => {
    it('enables a disabled plugin', async () => {
      const plugin = createMockPlugin({ enabled: false });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();
      const newIds = manager.togglePlugin('test-plugin@marketplace');

      expect(newIds).toContain('test-plugin@marketplace');
      expect(manager.getPlugins()[0].enabled).toBe(true);
    });

    it('disables an enabled plugin', async () => {
      const plugin = createMockPlugin({ enabled: true });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['test-plugin@marketplace']);
      await manager.loadPlugins();
      const newIds = manager.togglePlugin('test-plugin@marketplace');

      expect(newIds).not.toContain('test-plugin@marketplace');
      expect(manager.getPlugins()[0].enabled).toBe(false);
    });

    it('returns current IDs when plugin not found', async () => {
      const plugin = createMockPlugin();
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['test-plugin@marketplace']);
      await manager.loadPlugins();
      const newIds = manager.togglePlugin('nonexistent-plugin');

      expect(newIds).toContain('test-plugin@marketplace');
    });
  });

  describe('getPluginsKey', () => {
    it('returns empty string when no plugins are enabled', async () => {
      const plugin = createMockPlugin({ enabled: false });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();

      expect(manager.getPluginsKey()).toBe('');
    });

    it('returns stable key for active plugins', async () => {
      const plugins = [
        createMockPlugin({ id: 'plugin-b', enabled: true, pluginPath: '/path/b' }),
        createMockPlugin({ id: 'plugin-a', enabled: true, pluginPath: '/path/a' }),
      ];
      const storage = createMockStorage(plugins);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['plugin-a', 'plugin-b']);
      await manager.loadPlugins();

      const key = manager.getPluginsKey();
      // Should be sorted alphabetically by ID
      expect(key).toBe('plugin-a:/path/a|plugin-b:/path/b');
    });

    it('excludes unavailable plugins from key', async () => {
      const plugins = [
        createMockPlugin({ id: 'available-plugin', enabled: true, status: 'available' }),
        createMockPlugin({ id: 'unavailable-plugin', enabled: true, status: 'unavailable' }),
      ];
      const storage = createMockStorage(plugins);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['available-plugin', 'unavailable-plugin']);
      await manager.loadPlugins();

      const key = manager.getPluginsKey();
      expect(key).not.toContain('unavailable-plugin');
      expect(key).toContain('available-plugin');
    });
  });

  describe('hasEnabledPlugins', () => {
    it('returns true when at least one plugin is enabled and available', async () => {
      const plugin = createMockPlugin({ enabled: true, status: 'available' });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['test-plugin@marketplace']);
      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(true);
    });

    it('returns false when all enabled plugins are unavailable', async () => {
      const plugin = createMockPlugin({ enabled: true, status: 'unavailable' });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['test-plugin@marketplace']);
      await manager.loadPlugins();

      expect(manager.hasEnabledPlugins()).toBe(false);
    });
  });

  describe('hasPlugins', () => {
    it('returns true when plugins exist', async () => {
      const plugin = createMockPlugin();
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      await manager.loadPlugins();

      expect(manager.hasPlugins()).toBe(true);
    });

    it('returns false when no plugins exist', async () => {
      const storage = createMockStorage([]);
      const manager = new PluginManager(storage);

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
        enabled: true,
        status: 'available',
      });
      const storage = createMockStorage([plugin]);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['test-plugin']);
      await manager.loadPlugins();

      const paths = manager.getPluginCommandPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0].pluginName).toBe('Test Plugin');
      // Commands are at {installPath}/commands/, not {pluginPath}/commands/
      expect(paths[0].commandsPath).toBe('/path/to/plugin');
    });

    it('excludes disabled and unavailable plugins', async () => {
      const plugins = [
        createMockPlugin({ id: 'enabled-available', enabled: true, status: 'available', installPath: '/path/a' }),
        createMockPlugin({ id: 'disabled-available', enabled: false, status: 'available', installPath: '/path/b' }),
        createMockPlugin({ id: 'enabled-unavailable', enabled: true, status: 'unavailable', installPath: '/path/c' }),
      ];
      const storage = createMockStorage(plugins);
      const manager = new PluginManager(storage);

      manager.setEnabledPluginIds(['enabled-available', 'enabled-unavailable']);
      await manager.loadPlugins();

      const paths = manager.getPluginCommandPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0].commandsPath).toBe('/path/a');
    });
  });
});
