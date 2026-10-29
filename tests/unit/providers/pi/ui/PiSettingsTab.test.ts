const mockedModule0: any = await import('@/core/providers/ProviderSettingsCoordinator');
import * as fs from 'node:fs';

import { createMockEl } from '@test/helpers/MockElement';
import { applyTextInput } from '@test/helpers/settingsControls';

const mockRenderEnvironmentSettingsSection = vi.fn();
const mockCLIResolverReset = vi.fn();
const mockDiscoverModels = vi.fn();

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

interface MockToggleComponent {
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: Mock;
  value: boolean;
  onChange(callback: (value: boolean) => Promise<void> | void): MockToggleComponent;
}

interface MockTextComponent {
  inputEl: {
    [key: string]: unknown;
    addClass: Mock;
    style: Record<string, string>;
    toggleClass: Mock;
    value: string;
  };
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: Mock;
  setValue: Mock;
  value: string;
  onChange(callback: (value: string) => Promise<void> | void): MockTextComponent;
}

const MockSetting = vi.hoisted(() => class MockSetting {
  desc = '';
  heading = false;
  name = '';
  settingEl = { addClass: vi.fn() };
  textComponents: MockTextComponent[] = [];
  toggleComponents: MockToggleComponent[] = [];

  constructor(_container: unknown) {
    createdSettings.push(this);
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }

  addToggle(callback: (toggle: MockToggleComponent) => void): this {
    const component = createToggleComponent();
    this.toggleComponents.push(component);
    callback(component);
    return this;
  }

  addText(callback: (text: MockTextComponent) => void): this {
    const component = createTextComponent();
    this.textComponents.push(component);
    callback(component);
    return this;
  }
});
type MockSetting = InstanceType<typeof MockSetting>;

vi.mock('node:fs');
vi.mock('obsidian', () => ({
  Setting: MockSetting,
}));
vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));
function createSettingsRenderer() {
  return createPiSettingsTabRenderer({
    modelCatalog: { markStale: vi.fn() },
    cliResolver: {
      reset: mockCLIResolverReset,
    },
  } as unknown as Parameters<typeof createPiSettingsTabRenderer>[0]);
}
vi.mock('@/providers/pi/runtime/PiModelDiscoveryService', () => ({
  PiModelDiscoveryService: vi.fn().mockImplementation(function () { return ({
    discoverModels: mockDiscoverModels,
  }); }),
}));
import type { Mock } from 'vitest';

import { getPiProviderSettings } from '@/providers/pi/settings';
import { createPiSettingsTabRenderer } from '@/providers/pi/ui/PiSettingsTab';


const createdSettings: MockSetting[] = [];
const mockedExists = fs.existsSync as Mock;
const mockedStat = fs.statSync as Mock;

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.onChangeCallback = null;
  component.value = false;
  component.setValue = vi.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = (callback: (value: boolean) => Promise<void> | void): MockToggleComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.inputEl = {
    ...createMockEl('input'),
    addEventListener: vi.fn(),
    addClass: vi.fn(),
    style: {},
    toggleClass: vi.fn(),
    value: '',
  };
  component.onChangeCallback = null;
  component.value = '';
  component.setPlaceholder = vi.fn(() => component);
  component.setValue = vi.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
    return component;
  });
  component.onChange = (callback: (value: string) => Promise<void> | void): MockTextComponent => {
    component.onChangeCallback = callback;
    return component;
  };
  return component;
}

function createElement(): any {
  const classes = new Set<string>();
  const element: any = {
    ...createMockEl('div'),
    checked: false,
    open: false,
    placeholder: '',
    style: {},
    title: '',
    value: '',
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
    setText: vi.fn((value: string) => {
      element.text = value;
    }),
    empty: vi.fn(),
    setAttribute: vi.fn(),
    blur: vi.fn(),
    createEl: vi.fn((tag?: string, attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = tag;
      applyElementAttrs(child, attrs);
      return child;
    }),
    createDiv: vi.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'div';
      applyElementAttrs(child, attrs);
      return child;
    }),
    createSpan: vi.fn((attrs?: Record<string, unknown>) => {
      const child = createElement();
      child.tag = 'span';
      applyElementAttrs(child, attrs);
      return child;
    }),
  };

  return element;
}

function applyElementAttrs(element: any, attrs?: Record<string, unknown>): void {
  if (!attrs) {
    return;
  }
  if (typeof attrs.cls === 'string') {
    element.cls = attrs.cls;
  }
  if (typeof attrs.text === 'string') {
    element.text = attrs.text;
  }
  if (typeof attrs.value === 'string') {
    element.value = attrs.value;
  }
  if (typeof attrs.type === 'string') {
    element.type = attrs.type;
  }
}

function createContext(settings: Record<string, unknown>) {
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const runProviderExecutionTransition = vi.fn(async (
    _providerIds: string[],
    mutation: () => Promise<void>,
  ) => mutation());
  const mutateSettings = vi.fn(async (
    mutation: (current: any) => void | Promise<void>,
  ) => {
    await mutation(settings);
    await saveSettings();
  });
  const applyProviderRuntimeSettings = vi.fn(async (
    providerIds: string[],
    mutation: (current: any) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ) => runProviderExecutionTransition(providerIds, async () => {
    await mutateSettings(mutation);
    await onApplied?.();
  }));
  return {
    plugin: {
      storage: { installationKey: 'current-host' },
      applyProviderRuntimeSettings,
      runProviderExecutionTransition,
      saveSettings,
      settings,
      mutateSettings,
    },
    notifyProviderModelOptionsChanged: vi.fn(),
  };
}

function render(settings: Record<string, unknown>) {
  const context = createContext(settings);
  createSettingsRenderer().render(createElement(), context as any);
  return context;
}

function findSetting(name: string): MockSetting {
  const setting = [...createdSettings].reverse().find(entry => entry.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

vi.mock('@/core/device/InstallationKey', async () => ({
  ...(await vi.importActual<typeof import('@/core/device/InstallationKey')>('@/core/device/InstallationKey')),
  getInstallationKey: () => 'current-host',
}));

describe('PiSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdSettings.length = 0;
    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    mockDiscoverModels.mockResolvedValue({
      kind: 'completed',
      models: [],
    });
  });

  it.each([false, true])('clears legacy CLI configuration when restoring automatic detection (host override: %s)', async (hasHostOverride) => {
    const config = {
      cliPath: '/legacy/pi',
      cliPathsByHost: { 'other-host': '/keep/pi', ...(hasHostOverride ? { 'current-host': '/host/pi' } : {}) },
    };
    const settings: Record<string, unknown> = { providerConfigs: { pi: config } };
    render(settings);
    const input = findSetting('CLI path').textComponents[0];
    expect(input.value).toBe(hasHostOverride ? '/host/pi' : '/legacy/pi');
    await applyTextInput(input, '');
    expect(getPiProviderSettings(settings).cliPath).toBe('');
    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({ 'other-host': '/keep/pi' });
  });

  it('updates provider config when Pi is enabled', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: { enabled: false } } };
    const context = render(settings);

    const enableSetting = findSetting('Enable Pi');
    await enableSetting.toggleComponents[0].onChangeCallback?.(true);

    expect(getPiProviderSettings(settings).enabled).toBe(true);
    expect(context.plugin.saveSettings).toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('pi');
  });

  it('commits Pi enablement inside the execution transition without metadata startup', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: true } },
    };
    const context = render(settings);
    const enableSetting = findSetting('Enable Pi');
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      expect(providerIds).toEqual(['pi']);
      expect(getPiProviderSettings(settings).enabled).toBe(true);
      await mutation();
      expect(getPiProviderSettings(settings).enabled).toBe(false);
    });

    await enableSetting.toggleComponents[0].onChangeCallback?.(false);

    expect(context.plugin.runProviderExecutionTransition).toHaveBeenCalledTimes(1);
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('resynchronizes the Pi toggle when disabling the final provider is rejected', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: true } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable Pi').toggleComponents[0];
    const coordinator = mockedModule0
      .ProviderSettingsCoordinator;
    coordinator.canApplyProviderEnablement.mockImplementationOnce(() => false);
    toggle.setValue.mockClear();

    await toggle.onChangeCallback?.(false);

    expect(toggle.setValue).toHaveBeenLastCalledWith(true);
    expect(context.plugin.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(coordinator.applyProviderEnablement).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();

    await toggle.onChangeCallback?.(true);
  });

  it('restores the Pi enablement toggle when the execution transition fails', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: false } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable Pi').toggleComponents[0];
    context.plugin.runProviderExecutionTransition.mockRejectedValueOnce(
      new Error('transition failed'),
    );

    await expect(toggle.onChangeCallback?.(true)).rejects.toThrow(
      'transition failed',
    );

    expect(getPiProviderSettings(settings).enabled).toBe(false);
    expect(toggle.setValue).toHaveBeenLastCalledWith(false);
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('resynchronizes Pi enablement to durable settings after a late transition failure', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: { pi: { enabled: false } },
    };
    const context = render(settings);
    const toggle = findSetting('Enable Pi').toggleComponents[0];
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      _providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      await mutation();
      throw new Error('transition completion failed');
    });

    await expect(toggle.onChangeCallback?.(true)).rejects.toThrow(
      'transition completion failed',
    );

    expect(getPiProviderSettings(settings).enabled).toBe(true);
    expect(toggle.setValue).toHaveBeenLastCalledWith(true);
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('leaves skill and hidden-command management to the Skills tab', () => {
    render({ providerConfigs: { pi: {} } });

    expect(createdSettings.filter(setting => ['Skills', 'Commands', 'Hidden Pi commands and skills'].includes(setting.name))).toEqual([]);
  });

  it('validates host-scoped CLI paths and resets the resolver after valid changes', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: {} } };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];

    mockedExists.mockReturnValue(false);
    await applyTextInput(cliInput, '/missing/pi');
    expect(context.plugin.saveSettings).not.toHaveBeenCalled();
    expect(mockCLIResolverReset).not.toHaveBeenCalled();

    mockedExists.mockReturnValue(true);
    mockedStat.mockReturnValue({ isFile: () => true });
    await applyTextInput(cliInput, '/valid/pi');
    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/valid/pi',
    });
    expect(mockCLIResolverReset).toHaveBeenCalled();
    expect(context.plugin.saveSettings).toHaveBeenCalled();
  });

  it('accepts a CLI path pasted with surrounding quotes', async () => {
    const settings: Record<string, unknown> = { providerConfigs: { pi: {} } };
    render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];

    mockedExists.mockImplementation((filePath: unknown) => String(filePath) === '/my tools/pi');
    mockedStat.mockReturnValue({ isFile: () => true });
    await applyTextInput(cliInput, '"/my tools/pi"');

    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '"/my tools/pi"',
    });
  });

  it('commits the Pi CLI path and retains discovery inside the execution transition', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          cliPathsByHost: { 'current-host': '/old/pi' },
          discoveredModels: [{ encodedId: 'pi:test/cached', id: 'cached', provider: 'test', label: 'Cached', input: ['text'], reasoning: false, thinkingLevels: ['off'] }],
        },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    const order: string[] = [];
    mockCLIResolverReset.mockImplementationOnce(() => {
      order.push('resolver-reset');
    });
    context.plugin.runProviderExecutionTransition.mockImplementationOnce(async (
      providerIds: string[],
      mutation: () => Promise<void>,
    ) => {
      order.push('transition-start');
      expect(providerIds).toEqual(['pi']);
      expect(getPiProviderSettings(settings).cliPathsByHost['current-host'])
        .toBe('/old/pi');
      await mutation();
      order.push('settings-committed');
      expect(getPiProviderSettings(settings).discoveredModels).toHaveLength(1);
      expect(mockCLIResolverReset).toHaveBeenCalledTimes(1);
      order.push('transition-end');
    });

    await applyTextInput(cliInput, '/new/pi');

    expect(order).toEqual([
      'transition-start',
      'resolver-reset',
      'settings-committed',
      'transition-end',
    ]);
    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/new/pi',
    });
    expect(context.plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['pi'],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('retains the Pi CLI draft when transition setup fails before mutation', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: { cliPathsByHost: { 'current-host': '/old/pi' } },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    cliInput.inputEl.value = '/failed/pi';
    context.plugin.runProviderExecutionTransition.mockRejectedValueOnce(
      new Error('transition failed'),
    );

    await applyTextInput(cliInput, '/failed/pi');

    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/old/pi',
    });
    expect(cliInput.inputEl.value).toBe('/failed/pi');
    expect(mockCLIResolverReset).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });

  it('resynchronizes the Pi CLI input to durable settings when resolver reset fails', async () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: { cliPathsByHost: { 'current-host': '/old/pi' } },
      },
    };
    const context = render(settings);
    const cliInput = findSetting('CLI path').textComponents[0];
    cliInput.inputEl.value = '/new/pi';
    mockCLIResolverReset.mockImplementationOnce(() => {
      throw new Error('resolver reset failed');
    });

    await applyTextInput(cliInput, '/new/pi');

    expect(getPiProviderSettings(settings).cliPathsByHost).toEqual({
      'current-host': '/new/pi',
    });
    expect(cliInput.inputEl.value).toBe('/new/pi');
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  });
});

vi.mock('@/shared/settings/ProviderModelsSection', () => ({ renderProviderModelsSection: vi.fn(() => ({ refresh: vi.fn() })) }));
