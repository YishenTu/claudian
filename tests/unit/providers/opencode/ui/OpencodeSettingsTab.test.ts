import { createMockEl } from '@test/helpers/MockElement';
import { applyTextInput } from '@test/helpers/settingsControls';
import * as fs from 'fs';
import type { Mock, MockedFunction } from 'vitest';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { createOpencodeSettingsTabRenderer } from '@/providers/opencode/ui/OpencodeSettingsTab';



const mockGetHostnameKey = vi.fn(() => 'host-a');
const mockRenderEnvironmentSettingsSection = vi.fn();
const mockSaveSettings = vi.fn().mockResolvedValue(undefined);
const mockCLIResolverReset = vi.fn();
const mockMetadataLoadCatalog = vi.fn().mockResolvedValue(false);
const mockMetadataWarmModel = vi.fn().mockResolvedValue(false);

vi.mock('fs');
vi.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    canApplyProviderEnablement: vi.fn(() => true),
    applyProviderEnablement: vi.fn((settings: Record<string, unknown>, providerId: string, enabled: boolean) => {
      const providerConfigs = settings.providerConfigs as Record<string, { enabled: boolean }>;
      providerConfigs[providerId].enabled = enabled;
      return true;
    }),
  },
}));
vi.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public settingEl = { addClass: vi.fn() };
    public textComponents: MockTextComponent[] = [];
    public toggleComponents: MockToggleComponent[] = [];

    constructor(_container: unknown) {
      createdSettings.push(this);
    }

    setName(name: string) {
      this.name = name;
      return this;
    }

    setDesc(desc: string) {
      this.desc = desc;
      return this;
    }

    setHeading() {
      this.heading = true;
      return this;
    }

    addText(callback: (text: MockTextComponent) => void) {
      const component = createTextComponent();
      this.textComponents.push(component);
      callback(component);
      return this;
    }

    addToggle(callback: (toggle: MockToggleComponent) => void) {
      const component = createToggleComponent();
      this.toggleComponents.push(component);
      callback(component);
      return this;
    }
  }

  return {
    Setting: MockSetting,
  };
});

vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));

function createSettingsRenderer() {
  return createOpencodeSettingsTabRenderer({
    cliResolver: {
      reset: mockCLIResolverReset,
    },
    modelCatalog: { markStale: vi.fn() } as any,
    metadataService: {
      loadCatalog: mockMetadataLoadCatalog,
      warmModelMetadata: mockMetadataWarmModel,
    },
  });
}

interface MockTextComponent {
  value: string;
  placeholder: string;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: MockedFunction<(value: string) => MockTextComponent>;
  setValue: MockedFunction<(value: string) => MockTextComponent>;
  onChange: MockedFunction<(callback: (value: string) => Promise<void> | void) => MockTextComponent>;
  inputEl: {
    [key: string]: unknown;
    value: string;
    style: Record<string, string>;
    addClass: Mock;
    toggleClass: Mock;
  };
}

interface MockToggleComponent {
  value: boolean;
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: MockedFunction<(value: boolean) => MockToggleComponent>;
  onChange: MockedFunction<(callback: (value: boolean) => Promise<void> | void) => MockToggleComponent>;
}

type MockSettingRecord = {
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  toggleComponents: MockToggleComponent[];
};

const createdSettings: MockSettingRecord[] = [];

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.value = '';
  component.placeholder = '';
  component.onChangeCallback = null;
  component.inputEl = {
    ...createMockEl('input'),
    addEventListener: vi.fn(),
    value: '',
    style: {},
    addClass: vi.fn(),
    toggleClass: vi.fn(),
  };
  component.setPlaceholder = vi.fn((value: string) => {
    component.placeholder = value;
    return component;
  });
  component.setValue = vi.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
    return component;
  });
  component.onChange = vi.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });
  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.value = false;
  component.onChangeCallback = null;
  component.setValue = vi.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = vi.fn((callback: (value: boolean) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });
  return component;
}

function createElement(): any {
  const classes = new Set<string>();
  const element: any = {
    ...createMockEl('div'),
    value: '',
    checked: false,
    open: false,
    placeholder: '',
    title: '',
    style: {},
    classList: {
      add: vi.fn((cls: string) => classes.add(cls)),
      remove: vi.fn((cls: string) => classes.delete(cls)),
      toggle: vi.fn((cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(cls)) {
            classes.delete(cls);
            return false;
          }
          classes.add(cls);
          return true;
        }
        if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
        return force;
      }),
      contains: vi.fn((cls: string) => classes.has(cls)),
    },
    addClass: vi.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.add(item));
    }),
    removeClass: vi.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.delete(item));
    }),
    toggleClass: vi.fn((cls: string, force: boolean) => {
      if (force) {
        classes.add(cls);
      } else {
        classes.delete(cls);
      }
    }),
    hasClass: vi.fn((cls: string) => classes.has(cls)),
    appendText: vi.fn(),
    setText: vi.fn((value: string) => {
      element.text = value;
    }),
    empty: vi.fn(),
    setAttribute: vi.fn(),
    blur: vi.fn(),
    createEl: vi.fn((_tag?: string, attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = _tag;
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      if (attrs && typeof attrs.text === 'string') {
        child.text = attrs.text;
      }
      if (attrs && typeof attrs.value === 'string') {
        child.value = attrs.value;
      }
      if (attrs && typeof attrs.type === 'string') {
        child.type = attrs.type;
      }
      return child;
    }),
    createDiv: vi.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      return child;
    }),
    createSpan: vi.fn((_attrs?: Record<string, unknown>) => createElement()),
  };

  return element;
}

function createContainer(): any {
  return {
    createDiv: vi.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      return child;
    }),
    createEl: vi.fn((tag?: string, attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = tag;
      if (attrs && typeof attrs.cls === 'string') {
        child.cls = attrs.cls;
      }
      if (attrs && typeof attrs.text === 'string') {
        child.text = attrs.text;
      }
      return child;
    }),
  };
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  const plugin: any = {
    storage: { installationKey: mockGetHostnameKey() },
    settings: {
      providerConfigs: {
        opencode: {
          cliPath: '',
          cliPathsByHost: {},
          discoveredModels: [],
          enabled: true,
          environmentVariables: '',
          modelAliases: {},
          preferredThinkingByModel: {},
          visibleModels: [],
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
  };
  plugin.runProviderExecutionTransition = vi.fn(async (
    _providerIds: string[],
    mutation: () => Promise<unknown>,
  ) => mutation());
  plugin.mutateSettings = vi.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  plugin.applyProviderRuntimeSettings = vi.fn(async (
    providerIds: string[],
    mutation: (settings: any) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ) => plugin.runProviderExecutionTransition(providerIds, async () => {
    await plugin.mutateSettings(mutation);
    await onApplied?.();
  }));
  return plugin;
}

function createContext(plugin: any) {
  return {
    plugin,
    notifyProviderModelOptionsChanged: vi.fn(),
    renderCustomContextLimits: vi.fn(),
  };
}

function acquireSettingsLease(
  registry: ProviderExecutionLifecycleRegistry,
): Mock {
  const dispose = vi.fn().mockResolvedValue(undefined);
  registry.acquire({
    providerId: 'opencode',
    createSession: () => ({
      providerId: 'opencode',
      sessionInstanceId: 'opencode-settings-session',
      execute: vi.fn(),
      cancel: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue({
        providerId: 'opencode',
        revision: 0,
        status: 'idle',
      }),
      getStatus: vi.fn().mockReturnValue('idle'),
      onEvent: vi.fn().mockReturnValue(() => undefined),
      dispose,
    }),
  } as any, {} as any, 'chat');
  return dispose;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function findSetting(name: string): MockSettingRecord {
  const setting = createdSettings.find((candidate) => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

vi.mock('@/core/device/InstallationKey', async () => ({
  ...(await vi.importActual<typeof import('@/core/device/InstallationKey')>('@/core/device/InstallationKey')),
  getInstallationKey: () => mockGetHostnameKey(),
}));

describe('OpencodeSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as MockedFunction<typeof fs.statSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    vi.clearAllMocks();
    mockMetadataLoadCatalog.mockResolvedValue(false);
    mockMetadataWarmModel.mockResolvedValue(false);
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it.each([false, true])('clears legacy CLI configuration when restoring automatic detection (host override: %s)', async (hasHostOverride) => {
    const config = {
      cliPath: '/legacy/opencode',
      cliPathsByHost: { 'other-host': '/keep/opencode', ...(hasHostOverride ? { 'host-a': '/host/opencode' } : {}) },
    };
    const plugin = createPlugin();
    Object.assign(plugin.settings.providerConfigs.opencode, config);
    createSettingsRenderer().render(createContainer(), createContext(plugin));
    const input = findSetting('CLI path').textComponents[0];
    expect(input.value).toBe(hasHostOverride ? '/host/opencode' : '/legacy/opencode');
    await applyTextInput(input, '');
    expect(plugin.settings.providerConfigs.opencode.cliPath).toBe('');
    expect(plugin.settings.providerConfigs.opencode.cliPathsByHost).toEqual({ 'other-host': '/keep/opencode' });
  });

  it('refreshes title model options after OpenCode enablement changes', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    createSettingsRenderer().render(createContainer(), context);
    const enableSetting = findSetting('Enable OpenCode');
    await enableSetting.toggleComponents[0].onChangeCallback?.(false);

    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode');
  });

  it('commits enablement inside the OpenCode transition without launching metadata probes', async () => {
    const registry = new ProviderExecutionLifecycleRegistry();
    const dispose = acquireSettingsLease(registry);
    const plugin = createPlugin();
    plugin.settings.providerConfigs.opencode.enabled = false;
    let transitionActive = false;
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => registry.runTransition(providerIds as ['opencode'], async () => {
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    }));
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: Record<string, unknown>) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });
    const context = createContext(plugin);

    createSettingsRenderer().render(createContainer(), context);
    const toggle = findSetting('Enable OpenCode').toggleComponents[0];
    await flushPromises();
    mockMetadataLoadCatalog.mockClear();
    mockMetadataWarmModel.mockClear();
    await toggle.onChangeCallback?.(true);

    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['opencode'],
      expect.any(Function),
    );
    expect(plugin.settings.providerConfigs.opencode.enabled).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.getProviderGeneration('opencode')).toBe(1);
    expect(mockMetadataLoadCatalog).not.toHaveBeenCalled();
    expect(mockMetadataWarmModel).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode');
    await registry.dispose();
  });

  it.each([
    ['before mutation', false],
    ['after mutation', true],
  ] as const)(
    'resynchronizes the enable toggle when the transition fails %s',
    async (_phase, mutateBeforeFailure) => {
      const plugin = createPlugin();
      plugin.runProviderExecutionTransition.mockImplementation(async (
        _providerIds: string[],
        mutation: () => Promise<unknown>,
      ) => {
        if (mutateBeforeFailure) await mutation();
        throw new Error('enablement transition failed');
      });
      const context = createContext(plugin);

      createSettingsRenderer().render(createContainer(), context);
      const toggle = findSetting('Enable OpenCode').toggleComponents[0];
      toggle.value = false;
      toggle.setValue.mockClear();

      await expect(toggle.onChangeCallback?.(false)).rejects.toThrow(
        'enablement transition failed',
      );

      const persistedEnabled = plugin.settings.providerConfigs.opencode.enabled;
      expect(persistedEnabled).toBe(mutateBeforeFailure ? false : true);
      expect(toggle.setValue).toHaveBeenCalledWith(persistedEnabled);
      expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    },
  );

  it('accepts a CLI path pasted with surrounding quotes', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => String(filePath) === '/my tools/opencode');
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => mutation());
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: any) => void | Promise<void>,
    ) => {
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });

    createSettingsRenderer().render(createContainer(), createContext(plugin));
    await applyTextInput(findSetting('CLI path').textComponents[0], '"/my tools/opencode"');

    expect(plugin.settings.providerConfigs.opencode.cliPathsByHost).toEqual({
      'host-a': '"/my tools/opencode"',
    });
  });

  it('stores the CLI path and resets provider state inside an execution transition', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => String(filePath) === '/custom/opencode');
    let transitionActive = false;
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      expect(providerIds).toEqual(['opencode']);
      transitionActive = true;
      try {
        return await mutation();
      } finally {
        transitionActive = false;
      }
    });
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: any) => void | Promise<void>,
    ) => {
      expect(transitionActive).toBe(true);
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });
    mockCLIResolverReset.mockImplementation(() => {
      expect(transitionActive).toBe(true);
    });

    createSettingsRenderer().render(createContainer(), createContext(plugin));

    const cliPathSetting = findSetting('CLI path');
    await applyTextInput(cliPathSetting.textComponents[0], '/custom/opencode');

    expect(plugin.settings.providerConfigs.opencode.cliPathsByHost).toEqual({
      'host-a': '/custom/opencode',
    });
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
    expect(mockCLIResolverReset).toHaveBeenCalledTimes(1);
    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['opencode'],
      expect.any(Function),
    );
    expect(plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['opencode'],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('renders environment guidance without skill or command sections', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    createSettingsRenderer().render(createContainer(), context);

    expect(createdSettings.filter(setting => ['Skills', 'Commands', 'Hidden Commands and Skills'].includes(setting.name))).toEqual([]);
    expect(mockRenderEnvironmentSettingsSection).toHaveBeenCalledWith(expect.objectContaining({
      desc: 'Extra environment variables passed to OpenCode.',
      placeholder: 'OPENCODE_DB=/path/to/opencode.db',
    }));
  });
});

vi.mock('@/shared/settings/ProviderModelsSection', () => ({ renderProviderModelsSection: vi.fn(() => ({ refresh: vi.fn() })) }));
