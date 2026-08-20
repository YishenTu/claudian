const mockRenderedSettingNames: string[] = [];
const mockSettingDescriptionEls = new Map<string, MockContainer>();
const mockToggleChanges = new Map<string, (value: boolean) => Promise<void>>();
const mockTextChanges = new Map<string, (value: string) => Promise<void>>();
const mockGitStatusElements: Array<{
  attributes: Map<string, string>;
  className: string;
  parent: 'control' | 'name';
  title: string;
}> = [];

type MockChainableComponent = Record<string, jest.Mock> & {
  selectEl?: { replaceChildren: jest.Mock };
};

jest.mock('obsidian', () => {
  const obsidian = jest.requireActual('../../../__mocks__/obsidian');

  class MockSetting {
    private name = '';
    readonly descEl = createContainer();
    readonly controlEl = {
      createSpan: jest.fn(() => createGitStatusElement('control')),
    };
    readonly nameEl = {
      createSpan: jest.fn(() => createGitStatusElement('name')),
    };

    constructor(_containerEl: HTMLElement) {}

    setName(name: string): this {
      this.name = name;
      mockRenderedSettingNames.push(name);
      mockSettingDescriptionEls.set(name, this.descEl);
      return this;
    }

    setDesc(_description: string): this {
      return this;
    }

    setHeading(): this {
      return this;
    }

    addDropdown(callback: (dropdown: MockChainableComponent) => void): this {
      const dropdown = createChainableComponent();
      dropdown.selectEl = { replaceChildren: jest.fn() };
      callback(dropdown);
      return this;
    }

    addToggle(callback: (toggle: MockChainableComponent) => void): this {
      const toggle = createChainableComponent();
      toggle.onChange.mockImplementation((handler: (value: boolean) => Promise<void>) => {
        mockToggleChanges.set(this.name, handler);
        return toggle;
      });
      callback(toggle);
      return this;
    }

    addText(callback: (text: Record<string, unknown>) => void): this {
      const text = createTextComponent();
      (text.onChange as jest.Mock).mockImplementation(
        (handler: (value: string) => Promise<void>) => {
          mockTextChanges.set(this.name, handler);
          return text;
        },
      );
      callback(text);
      return this;
    }

    addTextArea(callback: (text: Record<string, unknown>) => void): this {
      callback(createTextComponent());
      return this;
    }

    addSlider(callback: (slider: MockChainableComponent) => void): this {
      callback(createChainableComponent());
      return this;
    }
  }

  function createGitStatusElement(parent: 'control' | 'name') {
    const element = {
      attributes: new Map<string, string>(),
      className: '',
      parent,
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      },
      title: '',
    };
    mockGitStatusElements.push(element);
    return element;
  }

  function createChainableComponent(): MockChainableComponent {
    const component: MockChainableComponent = {};
    for (const method of [
      'addOption',
      'setValue',
      'onChange',
      'setPlaceholder',
      'setLimits',
      'setDynamicTooltip',
    ]) {
      component[method] = jest.fn(() => component);
    }
    return component;
  }

  function createTextComponent(): Record<string, unknown> {
    return {
      ...createChainableComponent(),
      inputEl: {
        addClass: jest.fn(),
        addEventListener: jest.fn(),
        dataset: {},
        value: '',
        rows: 0,
        cols: 0,
      },
    };
  }

  return {
    ...obsidian,
    Setting: MockSetting,
  };
});

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { t } from '@/i18n/i18n';

function createTab(enableDualPane: boolean): {
  tab: ClaudianSettingTab;
  plugin: Record<string, any>;
} {
  const settings = { ...DEFAULT_CLAUDIAN_SETTINGS, enableDualPane };
  const plugin = {
    settings,
    mutateSettings: jest.fn(async (mutation: (value: typeof settings) => void) => {
      mutation(settings);
    }),
    getAllViews: jest.fn(() => [{ refreshDualPaneLayout: jest.fn() }]),
    notifyAgentSkillsChanged: jest.fn(),
    checkCollabGitInstallation: jest.fn().mockResolvedValue('available'),
    setCollabEnabled: jest.fn(async (enabled: boolean) => {
      settings.collabEnabled = enabled;
    }),
    setCollabProjectsFolder: jest.fn(async (raw: string) => {
      if (raw === '../outside') {
        return { message: 'Projects folder must stay inside the Vault.', ok: false as const };
      }
      const value = raw.trim();
      settings.collabProjectsFolder = value;
      return { ok: true as const, value };
    }),
    storage: {
      getAdapter: jest.fn(() => ({})),
    },
    warmExecutionPool: {
      reconcileLimit: jest.fn(),
    },
    providerHost: {
      settings,
      getEnvironmentVariablesForScope: jest.fn(() => ''),
      applyEnvironmentVariables: jest.fn(),
    },
  };

  return {
    tab: new ClaudianSettingTab({} as any, plugin as any),
    plugin,
  };
}

interface MockContainer extends Record<string, any> {
  readonly children: MockContainer[];
  readonly text?: string;
  click(): void;
}

function createContainer(options: { text?: string } = {}): MockContainer {
  const listeners = new Map<string, () => void>();
  const children: MockContainer[] = [];
  const attributes = new Map<string, string>();
  const element: MockContainer = {
    attributes,
    children,
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
    },
    ...options,
    click: () => listeners.get('click')?.(),
    createSpan: jest.fn((childOptions?: { text?: string }) => {
      const child = createContainer(childOptions);
      children.push(child);
      return child;
    }),
    createEl: jest.fn((_tag: string, childOptions?: { text?: string }) => {
      const child = createContainer(childOptions);
      children.push(child);
      return child;
    }),
    addEventListener: jest.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    addClass: jest.fn(),
    removeClass: jest.fn(),
    setAttribute: jest.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
    toggleClass: jest.fn(),
    title: '',
    empty: jest.fn(),
    setText: jest.fn(),
  };
  element.createDiv = jest.fn((childOptions?: { text?: string }) => {
    const child = createContainer(childOptions);
    children.push(child);
    return child;
  });
  return element;
}

function findContainer(root: MockContainer, text: string): MockContainer | null {
  if (root.text === text) return root;
  for (const child of root.children) {
    const match = findContainer(child, text);
    if (match) return match;
  }
  return null;
}

function findContainerByClass(root: MockContainer, className: string): MockContainer | null {
  if (root.cls === className) return root;
  for (const child of root.children) {
    const match = findContainerByClass(child, className);
    if (match) return match;
  }
  return null;
}

function renderSettingsTab(
  tab: ClaudianSettingTab,
  container = createContainer(),
): MockContainer {
  const [definition] = tab.getSettingDefinitions();
  if (
    !definition
    || !('render' in definition)
    || typeof definition.render !== 'function'
  ) {
    throw new Error('Expected a declarative settings renderer');
  }

  definition.render(
    { settingEl: container } as never,
    {} as never,
  );
  return container;
}

describe('ClaudianSettingTab display settings', () => {
  beforeEach(() => {
    mockRenderedSettingNames.length = 0;
    mockSettingDescriptionEls.clear();
    mockGitStatusElements.length = 0;
    mockToggleChanges.clear();
    mockTextChanges.clear();
  });

  it('renders the custom settings surface through a declarative definition', () => {
    const { tab } = createTab(true);
    const container = createContainer();
    const [definition] = tab.getSettingDefinitions();

    expect(definition).toEqual(expect.objectContaining({
      name: 'Claudian',
      searchable: false,
    }));
    expect(Object.hasOwn(ClaudianSettingTab.prototype, 'display')).toBe(false);

    renderSettingsTab(tab, container);

    expect(container.empty).toHaveBeenCalledTimes(1);
    expect(container.addClass).toHaveBeenCalledWith('claudian-settings');
    expect(findContainer(container, t('settings.tabs.general'))).not.toBeNull();
  });

  it('renders the dual-pane position only while dual-pane mode is enabled', () => {
    const enabled = createTab(true);
    (enabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).toContain(t('settings.dualPaneSide.name'));

    mockRenderedSettingNames.length = 0;
    const disabled = createTab(false);
    (disabled.tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).not.toContain(t('settings.dualPaneSide.name'));
    expect(mockRenderedSettingNames).toContain(t('settings.restoreTabsOnStartup.name'));
  });

  it('rerenders display settings after dual-pane mode changes', async () => {
    const { tab, plugin } = createTab(true);
    const update = jest.spyOn(tab, 'update').mockImplementation();
    (tab as any).renderGeneralTab(createContainer());

    await mockToggleChanges.get(t('settings.enableDualPane.name'))?.(false);

    expect(plugin.settings.enableDualPane).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('renders and updates the startup tab restore toggle', async () => {
    const { tab, plugin } = createTab(true);
    (tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).toContain(t('settings.restoreTabsOnStartup.name'));

    await mockToggleChanges.get(t('settings.restoreTabsOnStartup.name'))?.(false);

    expect(plugin.settings.restoreTabsOnStartup).toBe(false);
  });

  it('keeps Collab controls out of General settings', () => {
    const { tab, plugin } = createTab(true);
    (tab as any).renderGeneralTab(createContainer());

    expect(mockRenderedSettingNames).not.toContain(t('settings.collabEnabled.name'));
    expect(mockRenderedSettingNames).not.toContain(t('settings.collabProjectsFolder.name'));
    expect(mockRenderedSettingNames).not.toContain(t('settings.collabGitPath.name'));
    expect(plugin.settings.collabEnabled).toBe(false);
  });

  it('delegates live enablement and Projects-folder validation from Collab settings', async () => {
    const { tab, plugin } = createTab(true);
    (tab as any).renderCollabTab(createContainer());

    await mockToggleChanges.get(t('settings.collabEnabled.name'))?.(true);
    await mockTextChanges.get(t('settings.collabProjectsFolder.name'))?.('  shared/projects  ');
    await mockTextChanges.get(t('settings.collabProjectsFolder.name'))?.('../outside');

    expect(plugin.setCollabEnabled).toHaveBeenCalledWith(true);
    expect(plugin.settings.collabEnabled).toBe(true);
    expect(plugin.setCollabProjectsFolder).toHaveBeenNthCalledWith(1, '  shared/projects  ');
    expect(plugin.settings.collabProjectsFolder).toBe('shared/projects');
  });

  it('persists the Vault-scoped Native Git path from Collab settings', async () => {
    const { tab, plugin } = createTab(true);
    (tab as any).renderCollabTab(createContainer());

    await mockTextChanges.get(t('settings.collabGitPath.name'))?.('  /usr/local/bin/git  ');

    expect(plugin.settings.collabGitPath).toBe('/usr/local/bin/git');
  });

  it('shows Git detection status and debounces manual-path checks', async () => {
    jest.useFakeTimers();
    try {
      const { tab, plugin } = createTab(true);
      const activate = (tab as any).renderCollabTab(createContainer()) as () => void;

      activate();
      await Promise.resolve();
      await Promise.resolve();
      expect(plugin.checkCollabGitInstallation).toHaveBeenCalledWith(false);
      expect(mockGitStatusElements[0]?.parent).toBe('name');
      expect(mockGitStatusElements[0]?.className)
        .toContain('claudian-collab-git-path-status--available');

      plugin.checkCollabGitInstallation.mockResolvedValueOnce('unavailable');
      await mockTextChanges.get(t('settings.collabGitPath.name'))?.('/missing/git');
      expect(mockGitStatusElements[0]?.className)
        .toContain('claudian-collab-git-path-status--checking');
      expect(plugin.checkCollabGitInstallation).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
      expect(plugin.checkCollabGitInstallation).toHaveBeenLastCalledWith(true);
      expect(mockGitStatusElements[0]?.className)
        .toContain('claudian-collab-git-path-status--unavailable');
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders compact Git setup help and copies the prompt', async () => {
    jest.useFakeTimers();
    const writeText = jest.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { tab } = createTab(true);
    const container = createContainer();
    try {
      (tab as any).renderCollabTab(container);

      expect(findContainer(container, t('settings.collabGitInstallation.summary')))
        .not.toBeNull();
      expect(findContainer(container, [
        t('settings.collabGitInstallation.requirement'),
        t('settings.collabGitInstallation.verify'),
      ].join(' ')))
        .not.toBeNull();
      expect(findContainer(container, t('settings.collabGitInstallation.verify')))
        .toBeNull();
      expect(findContainer(container, t('settings.collabGitInstallation.prompt')))
        .not.toBeNull();
      expect(findContainerByClass(container, 'claudian-code-wrapper')).not.toBeNull();
      expect(findContainerByClass(container, 'copy-code-button')).not.toBeNull();
      expect(findContainerByClass(
        container,
        'claudian-collab-git-verification-row',
      )).toBeNull();
      expect(t('settings.collabGitInstallation.prompt')).toContain(
        'Report whether Git is installed',
      );
      expect(t('settings.collabGitInstallation.prompt')).toContain(
        'advise me how to install it on this device',
      );
      expect(t('settings.collabGitInstallation.prompt')).toBe([
        'Check my Git installation on this computer.',
        '1. Report whether Git is installed, the executable path, and the version.',
        '2. If Git is not installed, advise me how to install it on this device.',
        '3. Do not install or change anything.',
      ].join('\n'));
      expect(t('settings.collabGitInstallation.prompt')).not.toContain('Collab');
      const copyButton = findContainerByClass(container, 'copy-code-button');
      copyButton?.click();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(
        t('settings.collabGitInstallation.prompt'),
      );
      expect(copyButton?.setText).toHaveBeenCalledWith('Copied!');

      const collabEnabledDescription = mockSettingDescriptionEls.get(
        t('settings.collabEnabled.name'),
      )!;
      const readMore = findContainer(
        collabEnabledDescription,
        t('settings.collabReadMore'),
      );
      expect(readMore).not.toBeNull();
      expect(findContainer(container, t('settings.collabReadMore'))).toBeNull();
      expect(t('settings.collabReadMore')).toBe(
        'Read more about Claudian Collab Mode',
      );
      expect(readMore?.attr).toEqual(expect.objectContaining({
        href: 'https://claudian.md/docs/collab-mode/',
        rel: 'noopener noreferrer',
        target: '_blank',
      }));
      expect(readMore?.cls).toBe('claudian-collab-read-more-link');
    } finally {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it('keeps Provider initialization lazy and does not mutate chat selection on navigation', async () => {
    jest.spyOn(ProviderRegistry, 'getRegisteredProviderIds')
      .mockReturnValue(['claude', 'codex']);
    jest.spyOn(ProviderRegistry, 'getProviderDisplayName')
      .mockImplementation(providerId => providerId.toUpperCase());
    jest.spyOn(ProviderRegistry, 'getTitleGenerationModelOptions').mockReturnValue([]);
    const ensureInitialized = jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockResolvedValue(undefined);
    ensureInitialized.mockClear();
    jest.spyOn(ProviderWorkspaceRegistry, 'prepareSettings').mockResolvedValue(undefined);
    jest.spyOn(ProviderWorkspaceRegistry, 'getSettingsTabRenderer').mockReturnValue(null);
    const { tab, plugin } = createTab(true);
    renderSettingsTab(tab);
    expect(ensureInitialized).not.toHaveBeenCalled();

    (tab as any).activeTab = 'providers';
    renderSettingsTab(tab);
    await Promise.resolve();
    await Promise.resolve();

    expect(ensureInitialized).toHaveBeenCalledWith(
      expect.anything(),
      plugin.settings.settingsProvider,
      'settings-tab',
    );
    expect(plugin.mutateSettings).not.toHaveBeenCalled();
  });

  it('initializes each Provider settings tab once and reuses its rendered content', async () => {
    jest.spyOn(ProviderRegistry, 'getRegisteredProviderIds')
      .mockReturnValue(['claude', 'codex']);
    jest.spyOn(ProviderRegistry, 'getProviderDisplayName')
      .mockImplementation(providerId => providerId.toUpperCase());
    jest.spyOn(ProviderRegistry, 'getTitleGenerationModelOptions').mockReturnValue([]);
    const ensureInitialized = jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized')
      .mockResolvedValue(undefined);
    ensureInitialized.mockClear();
    jest.spyOn(ProviderWorkspaceRegistry, 'prepareSettings').mockResolvedValue(undefined);
    jest.spyOn(ProviderWorkspaceRegistry, 'getSettingsTabRenderer').mockReturnValue(null);
    const { tab } = createTab(true);
    const container = createContainer();
    (tab as any).activeTab = 'providers';

    renderSettingsTab(tab, container);
    await Promise.resolve();
    await Promise.resolve();
    findContainer(container, 'CODEX')?.click();
    await Promise.resolve();
    await Promise.resolve();
    findContainer(container, 'CLAUDE')?.click();
    await Promise.resolve();

    expect(ensureInitialized).toHaveBeenCalledTimes(2);
    expect(ensureInitialized.mock.calls.map(([, providerId]) => providerId))
      .toEqual(['claude', 'codex']);
  });
});
