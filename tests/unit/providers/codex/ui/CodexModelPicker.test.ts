import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';

import { getCodexProviderSettings } from '@/providers/codex/settings';
import { renderCodexModelPicker } from '@/providers/codex/ui/CodexModelPicker';

const settingNames: string[] = [];
const elements: FakeElement[] = [];
const mockNormalizeAllModelVariants = jest.fn();

jest.mock('@/core/providers/ProviderSettingsCoordinator', () => ({
  ProviderSettingsCoordinator: {
    normalizeAllModelVariants: (...args: unknown[]) => mockNormalizeAllModelVariants(...args),
  },
}));

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  Setting: class MockSetting {
    constructor(_container: unknown) {}

    setName(name: string) {
      settingNames.push(name);
      return this;
    }

    setDesc(_description: string) {
      return this;
    }
  },
}));

interface FakeElement {
  attrs: Record<string, string>;
  checked: boolean;
  children: FakeElement[];
  classes: Set<string>;
  disabled: boolean;
  open: boolean;
  parent: FakeElement | null;
  placeholder: string;
  tag: string;
  text: string;
  title: string;
  value: string;
  addEventListener(event: string, handler: () => unknown): void;
  appendText(value: string): void;
  classList: { add(value: string): void };
  createDiv(options?: { cls?: string; text?: string }): FakeElement;
  createEl(tag: string, options?: { cls?: string; text?: string; type?: string }): FakeElement;
  createSpan(options?: { cls?: string; text?: string }): FakeElement;
  empty(): void;
  setAttribute(name: string, value: string): void;
  setText(value: string): void;
  toggleClass(value: string, force: boolean): void;
  trigger(event: string): unknown[];
}

function createElement(
  tag = 'div',
  options: { cls?: string; text?: string; type?: string } = {},
  parent: FakeElement | null = null,
): FakeElement {
  const listeners = new Map<string, Array<() => unknown>>();
  const classes = new Set(options.cls?.split(/\s+/).filter(Boolean) ?? []);
  const element: FakeElement = {
    attrs: options.type ? { type: options.type } : {},
    checked: false,
    children: [],
    classes,
    disabled: false,
    open: false,
    parent,
    placeholder: '',
    tag,
    text: options.text ?? '',
    title: '',
    value: '',
    addEventListener(event, handler) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
    appendText(value) {
      element.text += value;
    },
    classList: {
      add(value) {
        classes.add(value);
      },
    },
    createDiv(childOptions = {}) {
      return appendChild(element, 'div', childOptions);
    },
    createEl(childTag, childOptions = {}) {
      return appendChild(element, childTag, childOptions);
    },
    createSpan(childOptions = {}) {
      return appendChild(element, 'span', childOptions);
    },
    empty() {
      element.children = [];
    },
    setAttribute(name, value) {
      element.attrs[name] = value;
    },
    setText(value) {
      element.text = value;
    },
    toggleClass(value, force) {
      if (force) {
        classes.add(value);
      } else {
        classes.delete(value);
      }
    },
    trigger(event) {
      return (listeners.get(event) ?? []).map(handler => handler());
    },
  };
  elements.push(element);
  return element;
}

function appendChild(
  parent: FakeElement,
  tag: string,
  options: { cls?: string; text?: string; type?: string },
): FakeElement {
  const child = createElement(tag, options, parent);
  parent.children.push(child);
  return child;
}

function createPlugin() {
  const plugin: any = {
    settings: {
      providerConfigs: {
        codex: {
          discoveredModels: TEST_CODEX_CATALOG,
          modelAliases: {},
          visibleModels: null,
        },
      },
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
  };
  plugin.mutateSettings = jest.fn(async (mutation: (settings: any) => void | Promise<void>) => {
    await mutation(plugin.settings);
    await plugin.saveSettings();
  });
  return plugin;
}

function createContext(plugin: ReturnType<typeof createPlugin>) {
  return {
    plugin,
    refreshModelSelectors: jest.fn(),
  } as any;
}

function findElement(predicate: (element: FakeElement) => boolean): FakeElement {
  const element = elements.find(predicate);
  if (!element) {
    throw new Error('Expected element was not rendered');
  }
  return element;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('CodexModelPicker', () => {
  beforeEach(() => {
    settingNames.length = 0;
    elements.length = 0;
    jest.clearAllMocks();
  });

  it('renders all app-server models selected by default and can clear the filter', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    renderCodexModelPicker(createElement() as any, context, {
      refreshModelCatalog: jest.fn(),
    } as any);

    expect(settingNames).toContain('Visible models');
    expect(elements.filter(element => element.attrs.type === 'checkbox').map(element => element.checked))
      .toEqual([true, true]);
    expect(elements.filter(element => element.tag === 'label').map(element => element.title))
      .toEqual(['gpt-5.4-mini', 'gpt-5.5']);

    findElement(element => element.attrs['aria-label'] === 'Clear all selected Codex models')
      .trigger('click');
    await flushPromises();

    expect(getCodexProviderSettings(plugin.settings).visibleModels).toEqual([]);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });

  it('registers void-returning DOM event callbacks for asynchronous actions', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const refreshModelCatalog = jest.fn().mockResolvedValue({
      changed: false,
      persistedSettingsChanged: false,
    });

    renderCodexModelPicker(createElement() as any, context, { refreshModelCatalog } as any);

    const actionButton = findElement(element =>
      element.classes.has('claudian-provider-model-picker-action')
    );
    expect(actionButton.trigger('click')).toEqual([undefined]);

    const catalog = findElement(element =>
      element.classes.has('claudian-provider-model-picker-catalog')
    );
    catalog.open = true;
    expect(catalog.trigger('toggle')).toEqual([undefined]);

    const aliasInput = findElement(element =>
      element.classes.has('claudian-provider-model-picker-selected-alias')
    );
    expect(aliasInput.trigger('blur')).toEqual([undefined]);

    const checkbox = findElement(element => element.attrs.type === 'checkbox');
    checkbox.checked = false;
    expect(checkbox.trigger('change')).toEqual([undefined]);

    const removeButton = findElement(element =>
      element.classes.has('claudian-provider-model-picker-selected-remove')
    );
    expect(removeButton.trigger('click')).toEqual([undefined]);

    const clearAllButton = findElement(element =>
      element.attrs['aria-label'] === 'Clear all selected Codex models'
    );
    expect(clearAllButton.trigger('click')).toEqual([undefined]);

    await flushPromises();
  });

  it('persists a catalog-ordered subset when a model is unchecked', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    renderCodexModelPicker(createElement() as any, context, {} as any);
    const miniRow = findElement(element => element.tag === 'label' && element.title === 'gpt-5.4-mini');
    const checkbox = miniRow.children.find(element => element.attrs.type === 'checkbox');
    if (!checkbox) {
      throw new Error('Expected model checkbox');
    }

    checkbox.checked = false;
    checkbox.trigger('change');
    await flushPromises();

    expect(getCodexProviderSettings(plugin.settings).visibleModels).toEqual(['gpt-5.5']);
  });

  it('persists aliases for selected models', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);

    renderCodexModelPicker(createElement() as any, context, {} as any);

    const aliasInput = findElement(element =>
      element.classes.has('claudian-provider-model-picker-selected-alias')
      && element.attrs['aria-label'] === 'Alias for GPT-5.5'
    );
    aliasInput.value = 'Primary';
    aliasInput.trigger('blur');
    await flushPromises();

    expect(getCodexProviderSettings(plugin.settings).modelAliases).toEqual({
      'gpt-5.5': 'Primary',
    });
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });

  it('refreshes the app-server catalog through the provider-owned persistence boundary', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const ensureFresh = jest.fn().mockResolvedValue({
      kind: 'completed',
      models: [],
      refreshed: true,
    });
    renderCodexModelPicker(createElement() as any, context, {
      modelCatalogCoordinator: { ensureFresh },
    } as any);

    findElement(element => element.classes.has('claudian-provider-model-picker-action'))
      .trigger('click');
    await flushPromises();

    expect(ensureFresh).toHaveBeenCalledWith('model-picker', { force: true });
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });

  it('does not save when refresh only changes the runtime catalog', async () => {
    const plugin = createPlugin();
    const context = createContext(plugin);
    const ensureFresh = jest.fn().mockResolvedValue({
      kind: 'completed',
      models: [],
      refreshed: false,
    });
    renderCodexModelPicker(createElement() as any, context, {
      modelCatalogCoordinator: { ensureFresh },
    } as any);

    findElement(element => element.classes.has('claudian-provider-model-picker-action'))
      .trigger('click');
    await flushPromises();

    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(context.refreshModelSelectors).toHaveBeenCalledTimes(1);
  });
});
