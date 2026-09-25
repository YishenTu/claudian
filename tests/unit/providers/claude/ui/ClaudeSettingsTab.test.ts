/** @jest-environment jsdom */

import { createMockEl } from '@test/helpers/MockElement';
import { applyTextInput } from '@test/helpers/settingsControls';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import * as fs from 'fs';
import { axe } from 'jest-axe';
import { setImmediate } from 'timers';

import { DEFAULT_CLAUDE_PROVIDER_SETTINGS } from '@/providers/claude/settings';
import { createClaudeSettingsTabRenderer } from '@/providers/claude/ui/ClaudeSettingsTab';

Object.assign(globalThis, { setImmediate });

const mockRenderEnvironmentSettingsSection = jest.fn();
const mockSaveSettings = jest.fn().mockResolvedValue(undefined);
const mockSlashCommandSettings = jest.fn();
const mockCLIResolverReset = jest.fn();
const mockModelCatalogRefresh = jest.fn().mockResolvedValue({ changed: true });
const mockVaultCommandRepository = {};
const mockModelCatalog = { refresh: mockModelCatalogRefresh, markStale: jest.fn() };
const mockRenderModelPicker = jest.fn((..._args: unknown[]) => ({ refresh: jest.fn(), dispose: jest.fn() }));

jest.mock('fs');
jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    canApplyProviderEnablement: jest.fn(() => true),
    applyProviderEnablement: jest.fn((
      settings: Record<string, unknown>,
      providerId: string,
      enabled: boolean,
    ) => {
      const providerConfigs = settings.providerConfigs as Record<string, { enabled: boolean }>;
      providerConfigs[providerId].enabled = enabled;
      return true;
    }),
  },
}));

jest.mock('obsidian', () => {
  class MockSetting {
    public name = '';
    public desc = '';
    public heading = false;
    public textComponents: MockTextComponent[] = [];
    public dropdownComponents: MockDropdownComponent[] = [];
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

    setClass(_className: string): this {
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

    addDropdown(callback: (dropdown: MockDropdownComponent) => void) {
      const component = createDropdownComponent();
      this.dropdownComponents.push(component);
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

jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({
  renderEnvironmentSettingsSection: (...args: unknown[]) => mockRenderEnvironmentSettingsSection(...args),
}));

function createSettingsRenderer() {
  return createClaudeSettingsTabRenderer({
    cliResolver: {
      reset: mockCLIResolverReset,
    },
    vaultCommandRepository: mockVaultCommandRepository,
    modelCatalog: mockModelCatalog,
  } as unknown as Parameters<typeof createClaudeSettingsTabRenderer>[0]);
}

jest.mock('@/shared/settings/ProviderModelsSection', () => ({
  renderProviderModelsSection: (...args: unknown[]) => mockRenderModelPicker(...args),
}));

jest.mock('@/providers/claude/ui/SlashCommandSettings', () => ({
  SlashCommandSettings: class MockSlashCommandSettings {
    constructor(...args: unknown[]) {
      mockSlashCommandSettings(...args);
    }
  },
}));

jest.mock('@/i18n/i18n', () => ({
  t: (key: string) => ({
    'settings.claude.responseStyle.name': 'Response style',
    'settings.claude.responseStyle.default': 'Default',
    'settings.claude.responseStyle.concise': 'Concise',
  } as Record<string, string>)[key] ?? key,
}));

jest.mock('@/utils/env', () => {
  const actual = jest.requireActual('@/utils/env');
  return {
    ...actual,
    getHostnameKey: () => 'host-a',
  };
});

interface MockInputEl {
  [key: string]: unknown;
  rows: number;
  cols: number;
  value: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  addClass: jest.Mock;
  toggleClass: jest.Mock;
  addEventListener: jest.Mock;
}

interface MockTextComponent {
  value: string;
  placeholder: string;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  setPlaceholder: jest.MockedFunction<(value: string) => MockTextComponent>;
  setValue: jest.MockedFunction<(value: string) => MockTextComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockTextComponent>;
  inputEl: MockInputEl;
}

interface MockDropdownComponent {
  selectEl: HTMLSelectElement;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChangeCallback: ((value: string) => Promise<void> | void) | null;
  addOption: jest.MockedFunction<(value: string, label: string) => MockDropdownComponent>;
  setValue: jest.MockedFunction<(value: string) => MockDropdownComponent>;
  onChange: jest.MockedFunction<(callback: (value: string) => Promise<void> | void) => MockDropdownComponent>;
}

interface MockToggleComponent {
  value: boolean;
  onChangeCallback: ((value: boolean) => Promise<void> | void) | null;
  setValue: jest.MockedFunction<(value: boolean) => MockToggleComponent>;
  onChange: jest.MockedFunction<(callback: (value: boolean) => Promise<void> | void) => MockToggleComponent>;
}

const createdSettings: Array<{
  name: string;
  desc: string;
  heading: boolean;
  textComponents: MockTextComponent[];
  dropdownComponents: MockDropdownComponent[];
  toggleComponents: MockToggleComponent[];
}> = [];

function createInputEl(): MockInputEl & { _listeners: Map<string, Array<() => void>> } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    ...createMockEl('input'),
    rows: 0,
    cols: 0,
    value: '',
    style: {},
    dataset: {},
    addClass: jest.fn(),
    toggleClass: jest.fn(),
    addEventListener: jest.fn((event: string, handler: () => void) => {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    }),
    _listeners: listeners,
  };
}

function createTextComponent(): MockTextComponent {
  const component = {} as MockTextComponent;
  component.value = '';
  component.placeholder = '';
  component.onChangeCallback = null;
  component.inputEl = createInputEl();
  component.setPlaceholder = jest.fn((value: string) => {
    component.placeholder = value;
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    component.inputEl.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    return component;
  });

  return component;
}

function createDropdownComponent(): MockDropdownComponent {
  const component = {} as MockDropdownComponent;
  component.selectEl = document.createElement('select');
  component.value = '';
  component.options = [];
  component.onChangeCallback = null;
  component.addOption = jest.fn((value: string, label: string) => {
    component.options.push({ value, label });
    component.selectEl.add(new Option(label, value));
    return component;
  });
  component.setValue = jest.fn((value: string) => {
    component.value = value;
    component.selectEl.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: string) => Promise<void> | void) => {
    component.onChangeCallback = callback;
    component.selectEl.addEventListener('change', () => { void callback(component.selectEl.value); });
    return component;
  });

  return component;
}

function createToggleComponent(): MockToggleComponent {
  const component = {} as MockToggleComponent;
  component.value = false;
  component.onChangeCallback = null;
  component.setValue = jest.fn((value: boolean) => {
    component.value = value;
    return component;
  });
  component.onChange = jest.fn((callback: (value: boolean) => Promise<void> | void) => {
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
    style: {},
    dataset: {},
    appendText: jest.fn(),
    createEl: jest.fn(() => createElement()),
    createDiv: jest.fn(() => createElement()),
    createSpan: jest.fn(() => createElement()),
    setText: jest.fn(),
    empty: jest.fn(),
    addClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.add(item));
    }),
    removeClass: jest.fn((cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((item) => classes.delete(item));
    }),
    toggleClass: jest.fn((cls: string, force: boolean) => {
      if (force) {
        classes.add(cls);
      } else {
        classes.delete(cls);
      }
    }),
    hasClass: jest.fn((cls: string) => classes.has(cls)),
    classList: {
      add: jest.fn((cls: string) => classes.add(cls)),
      remove: jest.fn((cls: string) => classes.delete(cls)),
      toggle: jest.fn((cls: string, force?: boolean) => {
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
      contains: jest.fn((cls: string) => classes.has(cls)),
    },
  };

  return element;
}

function createContainer(): any {
  return {
    createDiv: jest.fn(() => createElement()),
    createEl: jest.fn(() => createElement()),
  };
}

function createPlugin(overrides: Record<string, unknown> = {}): any {
  const plugin: any = {
    settings: {
      settingsProvider: 'claude',
      model: 'claude-opus-4-6',
      titleGenerationModel: '',
      providerConfigs: {
        claude: {
          ...DEFAULT_CLAUDE_PROVIDER_SETTINGS,
          discoveredModels: [{ value: 'opus', label: 'Opus', description: '' }, { value: 'claude-opus-4-6', label: 'Opus 4.6', description: '' }],
          visibleModels: ['opus', 'claude-opus-4-6'],
        },
      },
      ...overrides,
    },
    saveSettings: mockSaveSettings,
    runProviderExecutionTransition: jest.fn(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => mutation()),
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault',
        },
      },
    },
  };
  plugin.mutateSettings = jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  plugin.applyProviderRuntimeSettings = jest.fn(async (
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
    notifyProviderModelOptionsChanged: jest.fn(),
    renderAgentSkillSettings: jest.fn(),
    renderHiddenProviderCommandSetting: jest.fn(),
    renderCustomContextLimits: jest.fn(),
  };
}

function findSetting(name: string) {
  const setting = createdSettings.find(candidate => candidate.name === name);
  if (!setting) {
    throw new Error(`Setting not found: ${name}`);
  }
  return setting;
}

describe('ClaudeSettingsTab', () => {
  const mockedExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
  const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

  beforeEach(() => {
    createdSettings.length = 0;
    jest.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedStatSync.mockReturnValue({ isFile: () => true } as fs.Stats);
  });

  it.each([false, true])('clears legacy CLI configuration when restoring automatic detection (host override: %s)', async (hasHostOverride) => {
    const config = {
      cliPath: '/legacy/claude',
      cliPathsByHost: { 'other-host': '/keep/claude', ...(hasHostOverride ? { 'host-a': '/host/claude' } : {}) },
    };
    const plugin = createPlugin();
    Object.assign(plugin.settings.providerConfigs.claude, config);
    createSettingsRenderer().render(createContainer(), createContext(plugin));
    const input = findSetting('settings.cliPath.name').textComponents[0];
    expect(input.value).toBe(hasHostOverride ? '/host/claude' : '/legacy/claude');
    await applyTextInput(input, '');
    expect(plugin.settings.providerConfigs.claude.cliPath).toBe('');
    expect(plugin.settings.providerConfigs.claude.cliPathsByHost).toEqual({ 'other-host': '/keep/claude' });
  });

  it('persists response styles through an accessible native selector', async () => {
    const plugin = createPlugin();
    createSettingsRenderer().render(createContainer(), createContext(plugin));
    const subtree = document.createElement('main');
    subtree.appendChild(findSetting('Response style').dropdownComponents[0].selectEl);
    const select = within(subtree).getByRole('combobox', { name: 'Response style' }) as HTMLSelectElement;
    expect(select.value).toBe('Default');
    for (const value of ['Concise', 'Default']) {
      const option = within(select).getByRole('option', { name: value }) as HTMLOptionElement;
      fireEvent.change(select, { target: { value: option.value } });
      await waitFor(() => expect(plugin.settings.providerConfigs.claude.responseStyle).toBe(value));
    }
    expect(await axe(subtree)).toHaveNoViolations();
  });

  it('persists Claude enablement inside its execution transition and refreshes model options', async () => {
    let transitionActive = false;
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      expect(providerIds).toEqual(['claude']);
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
    const context = createContext(plugin);

    createSettingsRenderer().render(createContainer(), context);
    const toggle = findSetting('settings.providerEnablement.name').toggleComponents[0];
    await toggle.onChangeCallback?.(false);

    expect(plugin.settings.providerConfigs.claude.enabled).toBe(false);
    expect(mockModelCatalog.markStale).not.toHaveBeenCalled();
    expect(mockModelCatalogRefresh).not.toHaveBeenCalled();
    await toggle.onChangeCallback?.(true);
    expect(plugin.settings.providerConfigs.claude.enabled).toBe(true);
    expect(mockModelCatalogRefresh).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('claude');
  });

  it('warns when disabling Claude would leave no enabled provider', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const container = createContainer();
    const coordinator = jest.requireMock('@/core/providers/ProviderSettingsCoordinator')
      .ProviderSettingsCoordinator;
    coordinator.canApplyProviderEnablement.mockImplementationOnce(() => false);

    createSettingsRenderer().render(container, context);
    const warningCallIndex = container.createDiv.mock.calls.findIndex(
      ([options]: [{ text?: string }?]) => options?.text
        === 'settings.providerEnablement.lastProviderWarning',
    );
    const warningEl = container.createDiv.mock.results[warningCallIndex]?.value;
    const toggle = findSetting('settings.providerEnablement.name').toggleComponents[0];

    await toggle.onChangeCallback?.(false);

    expect(warningCallIndex).toBeGreaterThanOrEqual(0);
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', false);
    expect(plugin.settings.providerConfigs.claude.enabled).toBe(true);
    expect(plugin.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(coordinator.applyProviderEnablement).not.toHaveBeenCalled();
    expect(context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();

    await toggle.onChangeCallback?.(true);
  });

  it('persists and applies a CLI path inside the Claude execution transition', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => (
      String(filePath) === '/custom/claude'
    ));
    let transitionActive = false;
    const plugin = createPlugin();
    plugin.runProviderExecutionTransition.mockImplementation(async (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => {
      expect(providerIds).toEqual(['claude']);
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
    await applyTextInput(findSetting('settings.cliPath.name')
      .textComponents[0], '/custom/claude');

    expect(plugin.runProviderExecutionTransition).toHaveBeenCalledWith(
      ['claude'],
      expect.any(Function),
    );
    expect(plugin.applyProviderRuntimeSettings).toHaveBeenCalledWith(
      ['claude'],
      expect.any(Function),
      expect.any(Function),
    );
    expect(plugin.settings.providerConfigs.claude.cliPathsByHost).toEqual({
      'host-a': '/custom/claude',
    });
    expect(mockCLIResolverReset).toHaveBeenCalledTimes(1);
  });

  it('persists a CLI path pasted with surrounding quotes', async () => {
    mockedExistsSync.mockImplementation((filePath: fs.PathLike) => (
      String(filePath) === '/custom dir/claude'
    ));
    const plugin = createPlugin();
    plugin.mutateSettings.mockImplementation(async (
      mutation: (settings: any) => void | Promise<void>,
    ) => {
      await mutation(plugin.settings);
      await plugin.saveSettings();
    });
    plugin.runProviderExecutionTransition.mockImplementation(async (
      _providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => mutation());
    mockCLIResolverReset.mockImplementation(() => undefined);

    createSettingsRenderer().render(createContainer(), createContext(plugin));
    await applyTextInput(findSetting('settings.cliPath.name')
      .textComponents[0], '"/custom dir/claude"');

    expect(plugin.settings.providerConfigs.claude.cliPathsByHost).toEqual({
      'host-a': '"/custom dir/claude"',
    });
  });

  it('renders the default Claude settings layout and model controls', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const container = createContainer();
    createSettingsRenderer().render(container, context);

    const cliPathInput = findSetting('settings.cliPath.name').textComponents[0];
    expect(cliPathInput.placeholder).toContain('cli-wrapper.cjs');
    expect(cliPathInput.placeholder).not.toContain('cli.js');
    const names = createdSettings.map(setting => setting.name);
    expect(names).not.toContain('settings.enableOpus1M.name');
    expect(names).not.toContain('settings.enableSonnet1M.name');
    expect(names).not.toContain('Default model');
    expect(names).not.toContain('settings.customModels.name');
    const headings = createdSettings.filter(setting => setting.heading).map(setting => setting.name);
    expect(headings).toEqual(expect.arrayContaining(['settings.models', 'settings.safety']));
    expect(headings.indexOf('settings.models')).toBeLessThan(headings.indexOf('settings.safety'));
    expect(mockRenderModelPicker).toHaveBeenCalledWith(
      container, 'claude', 'Claude', mockModelCatalog, expect.any(Function),
    );
  });

  it('shows the shared no-model warning and updates it after selection and discovery', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.claude.visibleModels = [];
    function domElement(tag = 'div', info: any = {}): any {
      const element = document.createElement(tag);
      if (info.cls) element.className = info.cls;
      if (info.text) element.textContent = info.text;
      for (const [name, value] of Object.entries(info.attr ?? {})) element.setAttribute(name, String(value));
      return Object.assign(element, {
        createDiv: (options: any) => element.appendChild(domElement('div', options)),
        createSpan: (options: any) => element.appendChild(domElement('span', options)),
        appendText: (value: string) => element.append(value),
        createEl: (name: string, options: any) => element.appendChild(domElement(name, options)),
        empty: () => element.replaceChildren(),
        toggleClass: (name: string, value: boolean) => element.classList.toggle(name, value),
      });
    }
    const container = domElement();
    createSettingsRenderer().render(container, createContext(plugin));
    const warning = within(container).getByText('settings.providerEnablement.noModelsWarning');
    expect(warning.classList.contains('claudian-hidden')).toBe(false);
    const onUpdate = mockRenderModelPicker.mock.calls[0][4] as () => void;
    plugin.settings.providerConfigs.claude.visibleModels = ['opus'];
    onUpdate();
    expect(warning.classList.contains('claudian-hidden')).toBe(true);
    plugin.settings.providerConfigs.claude.discoveredModels = [];
    onUpdate();
    expect(warning.classList.contains('claudian-hidden')).toBe(false);
    await findSetting('settings.providerEnablement.name').toggleComponents[0].onChangeCallback?.(false);
    expect(warning.classList.contains('claudian-hidden')).toBe(true);
    const warningRegion = document.createElement('main');
    warningRegion.append(warning);
    expect(await axe(warningRegion)).toHaveNoViolations();
  });

  it('keeps Claude CRUD on its explicit vault repository without the shared manager', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    createSettingsRenderer().render(createContainer(), context);

    expect(context.renderAgentSkillSettings).not.toHaveBeenCalled();
    expect(mockSlashCommandSettings).toHaveBeenCalledWith(
      expect.anything(),
      plugin.app,
      mockVaultCommandRepository,
    );
  });

  it('scopes custom model overrides to the Claude environment section', () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const target = createContainer();

    createSettingsRenderer().render(createContainer(), context);

    const environmentOptions = mockRenderEnvironmentSettingsSection.mock.calls[0]?.[0];
    expect(environmentOptions).toEqual(expect.objectContaining({
      scope: 'provider:claude',
      renderCustomContextLimits: expect.any(Function),
    }));
    environmentOptions.renderCustomContextLimits(target);
    expect(context.renderCustomContextLimits).toHaveBeenCalledWith(target, 'claude');
  });

  it('offers auto as a Claude safe mode and persists it', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    createSettingsRenderer().render(createContainer(), context);

    const safeModeSetting = findSetting('settings.claudeSafeMode.name');
    const safeModeDropdown = safeModeSetting.dropdownComponents[0];

    expect(safeModeDropdown.options).toEqual([
      { value: 'acceptEdits', label: 'acceptEdits' },
      { value: 'auto', label: 'auto' },
      { value: 'default', label: 'default' },
    ]);

    await safeModeDropdown.onChangeCallback?.('auto');

    expect(plugin.settings.providerConfigs.claude.safeMode).toBe('auto');
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });
});
