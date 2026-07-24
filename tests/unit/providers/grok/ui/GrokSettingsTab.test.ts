import * as fs from 'node:fs';

import { getGrokProviderSettings } from '@/providers/grok/settings';
import { grokSettingsTabRenderer } from '@/providers/grok/ui/GrokSettingsTab';

const mockGetHostnameKey = jest.fn(() => 'device:current');
const mockRenderEnvironmentSettingsSection = jest.fn();
const mockRenderProviderModelPicker = jest.fn();
const mockCliResolverReset = jest.fn();
const mockRefreshModelCatalog = jest.fn().mockResolvedValue({ changed: false });
const mockGetServices = jest.fn(() => ({
  cliResolver: { reset: mockCliResolverReset },
  refreshModelCatalog: mockRefreshModelCatalog,
}));

jest.mock('node:fs');
jest.mock('obsidian', () => {
  class MockNotice {
    constructor(message: string) {
      notices.push(message);
    }
  }

  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(value: string) {
      this.name = value;
      return this;
    }

    setDesc(value: string) {
      this.desc = value;
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    addText(callback: (component: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addToggle(callback: (component: MockToggleComponent) => void) {
      const component = createToggleComponent();
      this.toggleComponents.push(component);
      callback(component);
      return this;
    }
  }

  return { Notice: MockNotice, Setting: MockSetting };
});
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    applyProviderEnablement: jest.fn((settings: Record<string, any>, providerId: string, enabled: boolean) => {
      settings.providerConfigs[providerId].enabled = enabled;
    }),
  },
}));
jest.mock('@/core/providers/ProviderWorkspaceRegistry', () => ({
  ProviderWorkspaceRegistry: {
    getServices: (_providerId: string) => mockGetServices(),
  },
}));
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));
jest.mock('@/shared/settings/ProviderModelPicker', () => ({
  renderProviderModelPicker: (...args: unknown[]) => {
    mockRenderProviderModelPicker(...args);
    return { refresh: jest.fn() };
  },
}));
jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
  getLegacyHostnameKey: () => 'legacy-host',
}));

interface MockTextComponent {
  inputEl: {
    addClass: jest.Mock;
    toggleClass: jest.Mock;
    value: string;
  };
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  placeholder: string;
  value: string;
  onChange(callback: (value: string) => Promise<void> | void): MockTextComponent;
  setPlaceholder(value: string): MockTextComponent;
  setValue(value: string): MockTextComponent;
}

interface MockToggleComponent {
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  value: boolean;
  onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
  setValue(value: boolean): MockToggleComponent;
}

interface MockSetting {
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  toggleComponents: MockToggleComponent[];
}

interface MockElement {
  children: MockElement[];
  cls?: string;
  tag?: string;
  text?: string;
  appendText(value: string): void;
  createDiv(options?: { cls?: string; text?: string }): MockElement;
  createEl(tag: string, options?: { cls?: string; text?: string }): MockElement;
  setText(value: string): void;
  toggleClass(cls: string, force: boolean): void;
}

const createdSettings: MockSetting[] = [];
const createdElements: MockElement[] = [];
const notices: string[] = [];

function createTextComponent(): MockTextComponent {
  const component: MockTextComponent = {
    inputEl: {
      addClass: jest.fn(),
      toggleClass: jest.fn(),
      value: '',
    },
    onChangeCallback: null,
    placeholder: '',
    value: '',
    onChange(callback: (value: string) => Promise<void> | void) {
      component.onChangeCallback = callback;
      return component;
    },
    setPlaceholder(value: string) {
      component.placeholder = value;
      return component;
    },
    setValue(value: string) {
      component.value = value;
      component.inputEl.value = value;
      return component;
    },
  };
  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component: MockToggleComponent = {
    onChangeCallback: null,
    value: false,
    onChange(callback: (value: boolean) => Promise<void> | void) {
      component.onChangeCallback = callback;
      return component;
    },
    setValue(value: boolean) {
      component.value = value;
      return component;
    },
  };
  return component;
}

function createElement(tag?: string, options?: { cls?: string; text?: string }): MockElement {
  const element: MockElement = {
    children: [],
    cls: options?.cls,
    tag,
    text: options?.text,
    appendText(value) {
      element.text = `${element.text ?? ''}${value}`;
    },
    createDiv(childOptions) {
      const child = createElement('div', childOptions);
      element.children.push(child);
      return child;
    },
    createEl(childTag, childOptions) {
      const child = createElement(childTag, childOptions);
      element.children.push(child);
      return child;
    },
    setText(value) {
      element.text = value;
    },
    toggleClass: jest.fn(),
  };
  createdElements.push(element);
  return element;
}

function createContainer(): HTMLElement {
  return createElement('div') as unknown as HTMLElement;
}

function makeCatalog() {
  return {
    defaultModelId: 'grok-4',
    fingerprint: 'catalog',
    models: [
      {
        defaultReasoningEffort: 'medium',
        displayName: 'Grok 4',
        rawId: 'grok-4',
        reasoningMetadataResolved: true,
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      },
      {
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      },
    ],
    refreshedAt: 100,
  };
}

function createPlugin(): any {
  const resetSession = jest.fn();
  const runtime = { cleanup: jest.fn(), resetSession };
  const conversation = {
    providerId: 'grok',
    providerState: { sessionDirectory: '/tmp/.grok/sessions/vault/session-1' },
    sessionId: 'session-1',
  };
  const plugin: any = {
    conversation,
    getEnvironmentVariablesForScope: jest.fn(() => ''),
    mutateSettings: jest.fn(async (mutation: (settings: Record<string, unknown>) => void | Promise<void>) => {
      await mutation(plugin.settings);
    }),
    mutateProviderSettingsAndRecycleRuntimes: jest.fn(async (
      _providerId: string,
      mutation: (settings: Record<string, unknown>) => void | Promise<void>,
    ) => {
      await plugin.mutateSettings(mutation);
      mockCliResolverReset();
      await plugin.recycleProviderRuntimes('grok');
    }),
    recycleProviderRuntimes: jest.fn(async () => {
      runtime.cleanup();
    }),
    runtime,
    settings: {
      providerConfigs: {
        grok: {
          catalogsByHost: { 'device:current': makeCatalog() },
          cliPathsByHost: {},
          enabled: true,
          modelAliases: {},
          preferredReasoningByModel: { 'grok-4': 'medium' },
          visibleModels: ['grok-4'],
        },
      },
    },
  };
  return plugin;
}

function createContext(plugin: any): any {
  return {
    plugin,
    notifyProviderModelOptionsChanged: jest.fn(),
    renderAgentSkillSettings: jest.fn(),
    renderCustomContextLimits: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
  };
}

function findSetting(name: string): MockSetting {
  const setting = createdSettings.find(candidate => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

function getPickerOptions(): any {
  const call = mockRenderProviderModelPicker.mock.calls.at(-1);
  if (!call) {
    throw new Error('Model picker was not rendered');
  }
  return call[0];
}

describe('GrokSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
  const mockedAccessSync = fs.accessSync as jest.MockedFunction<typeof fs.accessSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    createdElements.length = 0;
    notices.length = 0;
    jest.clearAllMocks();
    mockGetServices.mockReturnValue({
      cliResolver: { reset: mockCliResolverReset },
      refreshModelCatalog: mockRefreshModelCatalog,
    });
    mockRefreshModelCatalog.mockResolvedValue({ changed: false });
    mockedExistsSync.mockReturnValue(true);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
    mockedAccessSync.mockImplementation(() => undefined);
  });

  it('enables Grok and refreshes the workspace-owned catalog without spawning from the UI', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    grokSettingsTabRenderer.render(createContainer(), context);

    const enableSetting = findSetting('Enable Grok');
    expect(enableSetting.desc).toBe(
      'Make enabled Grok models available for new conversations. Existing sessions are preserved when disabled.',
    );
    await enableSetting.toggleComponents[0].onChangeCallback?.(true);

    expect(plugin.settings.providerConfigs.grok.enabled).toBe(true);
    expect(mockRefreshModelCatalog).toHaveBeenCalledTimes(1);
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('grok');
  });

  it('validates an executable CLI file before persisting it', async () => {
    const plugin = createPlugin();
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));

    mockedAccessSync.mockImplementation(() => {
      throw new Error('not executable');
    });
    await findSetting('CLI path').textComponents[0].onChangeCallback?.('/opt/grok');
    expect(plugin.mutateSettings).not.toHaveBeenCalled();

    mockedAccessSync.mockImplementation(() => undefined);
    await findSetting('CLI path').textComponents[0].onChangeCallback?.('/opt/grok');
    expect(getGrokProviderSettings(plugin.settings).cliPathsByHost).toEqual({
      'device:current': '/opt/grok',
    });
  });

  it('restores CLI path closure and input state after a pre-commit write failure', async () => {
    const plugin = createPlugin();
    const writeError = new Error('write failed');
    plugin.mutateProviderSettingsAndRecycleRuntimes.mockRejectedValueOnce(writeError);
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));
    const input = findSetting('CLI path').textComponents[0];

    input.inputEl.value = '/opt/grok';
    await expect(input.onChangeCallback?.('/opt/grok')).rejects.toBe(writeError);

    expect(getGrokProviderSettings(plugin.settings).cliPathsByHost).toEqual({});
    expect(input.inputEl.value).toBe('');

    input.inputEl.value = '/opt/grok';
    await expect(input.onChangeCallback?.('/opt/grok')).resolves.toBeUndefined();

    expect(plugin.mutateProviderSettingsAndRecycleRuntimes).toHaveBeenCalledTimes(2);
    expect(plugin.mutateSettings).toHaveBeenCalledTimes(1);
    expect(getGrokProviderSettings(plugin.settings).cliPathsByHost).toEqual({
      'device:current': '/opt/grok',
    });
  });

  it('keeps a committed CLI path after recycle failure and allows reverting it', async () => {
    const plugin = createPlugin();
    const recycleError = new Error('recycle failed');
    plugin.recycleProviderRuntimes.mockRejectedValueOnce(recycleError);
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));
    const input = findSetting('CLI path').textComponents[0];

    input.inputEl.value = '/opt/grok';
    await expect(input.onChangeCallback?.('/opt/grok')).rejects.toBe(recycleError);

    expect(getGrokProviderSettings(plugin.settings).cliPathsByHost).toEqual({
      'device:current': '/opt/grok',
    });
    expect(input.inputEl.value).toBe('/opt/grok');

    input.inputEl.value = '';
    await expect(input.onChangeCallback?.('')).resolves.toBeUndefined();

    expect(plugin.mutateProviderSettingsAndRecycleRuntimes).toHaveBeenCalledTimes(2);
    expect(plugin.mutateSettings).toHaveBeenCalledTimes(2);
    expect(plugin.recycleProviderRuntimes).toHaveBeenCalledTimes(2);
    expect(getGrokProviderSettings(plugin.settings).cliPathsByHost).toEqual({});
  });

  it('rejects an existing relative CLI path', async () => {
    const plugin = createPlugin();
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));

    await findSetting('CLI path').textComponents[0].onChangeCallback?.('bin/grok');

    expect(plugin.mutateSettings).not.toHaveBeenCalled();
    expect(mockedExistsSync).not.toHaveBeenCalled();
  });

  it('clears only the current catalog, resets resolution, and recycles without resetting the session', async () => {
    const plugin = createPlugin();
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));

    await findSetting('CLI path').textComponents[0].onChangeCallback?.('/opt/grok');

    expect(getGrokProviderSettings(plugin.settings).currentCatalog).toBeNull();
    expect(mockCliResolverReset).toHaveBeenCalledTimes(1);
    expect(plugin.mutateProviderSettingsAndRecycleRuntimes).toHaveBeenCalledWith(
      'grok',
      expect.any(Function),
    );
    expect(plugin.recycleProviderRuntimes).toHaveBeenCalledWith('grok');
    expect(plugin.runtime.cleanup).toHaveBeenCalledTimes(1);
    expect(plugin.runtime.resetSession).not.toHaveBeenCalled();
    expect(plugin.conversation).toEqual({
      providerId: 'grok',
      providerState: { sessionDirectory: '/tmp/.grok/sessions/vault/session-1' },
      sessionId: 'session-1',
    });
  });

  it('omits authentication and BYOK documentation sections', () => {
    const plugin = createPlugin();
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(createdSettings.map(setting => setting.name)).not.toEqual(expect.arrayContaining([
      'Authentication',
      'Grok account',
      'Bring your own model',
      'Grok-native custom models',
    ]));
    expect(mockRenderEnvironmentSettingsSection).toHaveBeenCalledWith(expect.objectContaining({
      heading: 'Environment',
      scope: 'provider:grok',
    }));
  });

  it('delegates refresh and reports concise workspace diagnostics', async () => {
    mockRefreshModelCatalog.mockResolvedValue({
      changed: false,
      diagnostics: 'Grok CLI is not logged in',
    });
    const plugin = createPlugin();
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));

    expect(await getPickerOptions().loadCatalog(true)).toBe('failed');
    expect(mockRefreshModelCatalog).toHaveBeenCalledTimes(1);
    expect(notices).toEqual(['Grok model discovery failed: Grok CLI is not logged in']);
  });

  it('persists picker visibility and aliases for discovered raw model ids', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    grokSettingsTabRenderer.render(createContainer(), context);
    const picker = getPickerOptions();

    expect(picker.getState()).toEqual(expect.objectContaining({
      aliases: {},
      discoveredCount: 2,
      selectedIds: ['grok-4'],
    }));
    expect(picker.getState().models.map((model: { id: string }) => model.id)).toEqual([
      'grok-4',
      'kimi-coding',
    ]);

    await picker.onAliasesChange({ 'grok-4': 'Primary' });
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledTimes(1);
    context.notifyProviderModelOptionsChanged.mockClear();
    await picker.onSelectedIdsChange(['grok-4', 'kimi-coding']);

    expect(getGrokProviderSettings(plugin.settings).modelAliases).toEqual({ 'grok-4': 'Primary' });
    expect(getGrokProviderSettings(plugin.settings).visibleModels).toBeNull();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('grok');
  });

  it('prunes reasoning metadata and preferences when a model is disabled', async () => {
    const plugin = createPlugin();
    grokSettingsTabRenderer.render(createContainer(), createContext(plugin));

    await getPickerOptions().onSelectedIdsChange(['kimi-coding']);

    const settings = getGrokProviderSettings(plugin.settings);
    expect(settings.preferredReasoningByModel).toEqual({});
    expect(settings.currentCatalog?.models.find(model => model.rawId === 'grok-4'))
      .toEqual(expect.objectContaining({
        reasoningEfforts: [],
        supportsReasoning: false,
      }));
    expect(settings.currentCatalog?.models.find(model => model.rawId === 'grok-4'))
      .not.toHaveProperty('reasoningMetadataResolved');
  });

  it('renders only hidden runtime commands and the Grok environment scope', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const container = createContainer();
    grokSettingsTabRenderer.render(container, context);

    expect(context.renderAgentSkillSettings).toHaveBeenCalledWith(
      container,
      'grok',
    );
    expect(context.renderHiddenProviderCommandSetting).toHaveBeenCalledWith(
      container,
      'grok',
      expect.objectContaining({ name: 'Hidden Grok commands' }),
    );
    expect(mockRenderEnvironmentSettingsSection).toHaveBeenCalledWith(expect.objectContaining({
      plugin,
      scope: 'provider:grok',
    }));
    expect(createdSettings.map(setting => setting.name)).not.toEqual(expect.arrayContaining([
      'Agents',
      'MCP servers',
      'Skills',
      'Subagents',
    ]));
  });
});
