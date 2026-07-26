import { createMockEl } from '@test/helpers/mockElement';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { kimiSettingsTabRenderer } from '@/providers/kimi/ui/KimiSettingsTab';

const createdSettings: Array<{ name: string; heading: boolean }> = [];
const mockMcpSettingsManagerCalls: Array<{
  containerEl: unknown;
  deps: {
    mcpStorage: unknown;
    broadcastMcpReload: () => Promise<void>;
  };
}> = [];

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  Setting: class MockSetting {
    public name = '';
    public heading = false;

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(name: string) {
      this.name = name;
      return this;
    }

    setDesc() {
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    addText(callback: (text: unknown) => void) {
      callback({
        setPlaceholder() { return this; },
        setValue() { return this; },
        onChange() { return this; },
        inputEl: { addClass: jest.fn(), toggleClass: jest.fn() },
      });
      return this;
    }

    addToggle(callback: (toggle: unknown) => void) {
      callback({
        setValue() { return this; },
        onChange() { return this; },
      });
      return this;
    }
  },
}));

jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: jest.fn(),
}));

jest.mock('@/shared/settings/ProviderModelPicker', () => ({
  renderProviderModelPicker: jest.fn(),
}));

jest.mock('@/shared/settings/McpSettingsManager', () => ({
  McpSettingsManager: jest.fn().mockImplementation((
    containerEl: unknown,
    deps: { mcpStorage: unknown; broadcastMcpReload: () => Promise<void> },
  ) => {
    mockMcpSettingsManagerCalls.push({ containerEl, deps });
  }),
}));

function createMockContext(): any {
  const plugin: any = {
    app: {},
    mutateSettings: jest.fn(async (mutation: (settings: unknown) => void | Promise<void>) => {
      await mutation(plugin.settings);
    }),
    broadcastToAllViewRuntimes: jest.fn().mockResolvedValue(undefined),
    settings: { providerConfigs: { kimi: {} } },
  };
  return {
    plugin,
    renderAgentSkillSettings: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
    notifyProviderModelOptionsChanged: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

describe('KimiSettingsTab MCP section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createdSettings.length = 0;
    mockMcpSettingsManagerCalls.length = 0;
  });

  afterEach(() => {
    ProviderWorkspaceRegistry.setServices('kimi', null as never);
  });

  it('renders the shared MCP manager against the vault mcp storage', () => {
    const mcpStorage = { load: jest.fn(), save: jest.fn() };
    ProviderWorkspaceRegistry.setServices('kimi', {
      cliResolver: { resolveFromSettings: jest.fn().mockResolvedValue(null), reset: jest.fn() },
      mcpStorage,
      refreshModelCatalog: jest.fn().mockResolvedValue({ changed: false }),
    } as never);
    const context = createMockContext();

    kimiSettingsTabRenderer.render(createMockEl() as unknown as HTMLElement, context);

    const heading = createdSettings.find((setting) => setting.heading && setting.name === 'MCP Servers');
    expect(heading).toBeDefined();
    expect(mockMcpSettingsManagerCalls).toHaveLength(1);
    expect(mockMcpSettingsManagerCalls[0].deps.mcpStorage).toBe(mcpStorage);
  });

  it('broadcasts MCP reloads to every view runtime after changes', async () => {
    ProviderWorkspaceRegistry.setServices('kimi', {
      cliResolver: { resolveFromSettings: jest.fn().mockResolvedValue(null), reset: jest.fn() },
      mcpStorage: { load: jest.fn(), save: jest.fn() },
      refreshModelCatalog: jest.fn().mockResolvedValue({ changed: false }),
    } as never);
    const context = createMockContext();

    kimiSettingsTabRenderer.render(createMockEl() as unknown as HTMLElement, context);
    const service = { reloadMcpServers: jest.fn().mockResolvedValue(undefined) };
    context.plugin.broadcastToAllViewRuntimes.mockImplementation(
      async (action: (runtime: unknown) => Promise<void>) => action(service),
    );

    await mockMcpSettingsManagerCalls[0].deps.broadcastMcpReload();

    expect(context.plugin.broadcastToAllViewRuntimes).toHaveBeenCalled();
    expect(service.reloadMcpServers).toHaveBeenCalled();
  });

  it('omits the MCP section when workspace services are unavailable', () => {
    ProviderWorkspaceRegistry.setServices('kimi', null as never);
    const context = createMockContext();

    kimiSettingsTabRenderer.render(createMockEl() as unknown as HTMLElement, context);

    expect(mockMcpSettingsManagerCalls).toHaveLength(0);
  });
});
