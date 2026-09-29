/** @jest-environment jsdom */

import '@test/helpers/ObsidianSettingsDOM';

import { deserialize, serialize } from 'node:v8';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { ModelSelector, type ToolbarCallbacks } from '@/features/chat/ui/InputToolbar';
import type { ClaudeModelDiscovery } from '@/providers/claude/runtime/ClaudeModels';
import { createClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';

jest.mock('obsidian', () => ({
  Setting: class {
    settingEl: HTMLElement;
    constructor(container: HTMLElement) { this.settingEl = container.createDiv(); }
    setName(value: string) { this.settingEl.createDiv({ text: value }); return this; }
    setDesc(value: string) { this.settingEl.createDiv({ text: value }); return this; }
  },
}));

HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
  this: HTMLElement, tag: K, info?: DomElementInfo | string, callback?: (element: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (typeof info === 'string') element.className = info;
  else if (info) {
    if (info.cls) element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    if (info.text) element.append(info.text);
    if (typeof info.type === 'string') element.setAttribute('type', info.type);
    for (const [name, value] of Object.entries(info.attr ?? {})) element.setAttribute(name, String(value));
  }
  this.appendChild(element);
  callback?.(element);
  return element;
};
HTMLElement.prototype.toggleClass = function (names, value) {
  for (const name of typeof names === 'string' ? [names] : names) this.classList.toggle(name, value);
};
HTMLElement.prototype.appendText = function (text) { this.append(text); };

function renderModels(container: HTMLElement, context: ProviderSettingsTabRendererContext, native: { refresh: ClaudeModelDiscovery }) {
  context.plugin.notifyProviderChatOptionsChanged = jest.fn();
  return renderProviderModelsSection(container, 'claude', 'Claude', createClaudeModels(context.plugin, signal => native.refresh(signal)));
}

describe('Claude model picker', () => {
  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    document.body.replaceChildren();
  });

  it.each(['default', 'claude-code/default'])('hides saved %s from management and chat choices', async (savedId) => {
    const container = document.body.createDiv();
    const settings = { model: 'opus', providerConfigs: { claude: {
      visibleModels: [savedId, 'opus'],
      discoveredModels: [
        { value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
        { value: 'opus', label: 'Opus', resolvedModel: 'claude-opus-5-5' },
      ],
    } } };
    const context = {
      plugin: { settings, mutateSettings: async (fn: (value: unknown) => void) => fn(settings) },
    } as unknown as ProviderSettingsTabRendererContext;
    renderModels(container, context, { refresh: jest.fn().mockResolvedValue({ changed: false }) });
    await waitFor(() => expect((within(container).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(container).queryByRole('checkbox', { name: /default/i })).toBeNull();
    expect(within(container).getAllByRole('checkbox')).toEqual([within(container).getByRole('checkbox', { name: /Opus/ })]);
    expect(within(container).queryByRole('button', { name: /Reorder .*default/i })).toBeNull();
    expect(claudeChatUIConfig.getModelOptions(settings).map(model => model.value)).toEqual(['opus']);
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('opus');
    expect(settings.providerConfigs.claude.visibleModels).toEqual([savedId, 'opus']);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('loads on opening the panel, refreshes manually, and uses selected order as default', async () => {
    const container = document.body.createDiv();
    const config = { discoveredModels: [] as Array<{value: string; label: string; description: string}>, visibleModels: [] as string[] };
    const settings = { providerConfigs: { claude: config } };
    const context = {
      plugin: { settings, mutateSettings: async (fn: (value: unknown) => void) => fn(settings) },
    } as unknown as ProviderSettingsTabRendererContext;
    const catalog = { refresh: jest.fn(async () => {
      settings.providerConfigs.claude.discoveredModels = [
        { value: 'gateway-model', label: 'Gateway model', description: 'From SDK' },
        { value: 'sonnet', label: 'Sonnet', description: 'From SDK' },
      ];
      return { changed: true };
    }) };
    renderModels(container, context, catalog);
    await waitFor(() => expect((within(container).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false));
    expect(catalog.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(within(container).getByRole('checkbox', { name: /Gateway model/ }));
    await waitFor(() => expect(settings.providerConfigs.claude.visibleModels).toEqual(['gateway-model']));
    fireEvent.click(within(container).getByRole('checkbox', { name: /Sonnet/ }));
    await waitFor(() => expect(settings.providerConfigs.claude.visibleModels).toEqual(['gateway-model', 'sonnet']));
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('claude-code/gateway-model');
    fireEvent.keyDown(within(container).getByRole('button', { name: /Reorder Sonnet/ }), { key: 'ArrowUp' });
    await waitFor(() => expect(settings.providerConfigs.claude.visibleModels).toEqual(['sonnet', 'gateway-model']));
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('sonnet');
    expect(catalog.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(within(container).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(catalog.refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((within(container).getByRole('button', { name: /Refresh|Discover/ }) as HTMLButtonElement).disabled).toBe(false));
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps chat order aligned with panel order before and after a reorder', async () => {
    const container = document.body.createDiv();
    const settings = { model: 'opus', providerConfigs: { claude: {
      visibleModels: ['sonnet', 'opus', 'gateway-model'],
      discoveredModels: [
        { value: 'opus', label: 'Opus' },
        { value: 'gateway-model', label: 'Gateway model' },
        { value: 'sonnet', label: 'Sonnet' },
      ],
    } } };
    const context = {
      plugin: { settings, mutateSettings: async (fn: (value: unknown) => void) => fn(settings) },
    } as unknown as ProviderSettingsTabRendererContext;
    renderModels(container, context, { refresh: jest.fn().mockResolvedValue({ changed: false }) });
    const toolbar = document.body.createDiv();
    const selector = new ModelSelector(toolbar, {
      getSettings: () => settings,
      getUIConfig: () => claudeChatUIConfig,
    } as unknown as ToolbarCallbacks);
    const chatLabels = () => [...toolbar.querySelectorAll('.claudian-model-option')].map(el => el.textContent);
    expect(chatLabels()).toEqual(['Sonnet', 'Opus', 'Gateway model']);
    fireEvent.keyDown(within(container).getByRole('button', { name: /Reorder Opus/ }), { key: 'ArrowUp' });
    await waitFor(() => expect(settings.providerConfigs.claude.visibleModels).toEqual(['opus', 'sonnet', 'gateway-model']));
    selector.renderOptions();
    expect(chatLabels()).toEqual(['Opus', 'Sonnet', 'Gateway model']);
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('opus');
  });

  it('shows manual refresh guidance and clears it when the selected model becomes available', () => {
    const toolbar = document.body.createDiv();
    const settings = { model: 'sonnet', providerConfigs: { claude: {
      visibleModels: ['sonnet'], discoveredModels: [] as Array<{ value: string; label: string }>,
    } } };
    const selector = new ModelSelector(toolbar, {
      getSettings: () => settings,
      getUIConfig: () => claudeChatUIConfig,
    } as unknown as ToolbarCallbacks);
    expect(within(toolbar).getByText('Model unavailable').parentElement?.title).toMatch(/refresh/i);
    expect(within(toolbar).getByRole('status').textContent).toMatch(/refresh/i);
    settings.providerConfigs.claude.discoveredModels = [{ value: 'sonnet', label: 'Sonnet' }];
    selector.updateDisplay();
    expect(within(toolbar).getByText('Sonnet').parentElement?.title).toBe('');
  });

  it('projects a saved native ID onto its SDK row without rewriting the saved choice', async () => {
    const container = document.body.createDiv();
    const settings = { providerConfigs: { claude: {
      visibleModels: ['gateway-model'],
      discoveredModels: [{ value: 'sonnet', label: 'Sonnet', description: '', resolvedModel: 'gateway-model' }],
    } } };
    const context = {
      plugin: { settings, mutateSettings: async (fn: (value: unknown) => void) => fn(settings) },
    } as unknown as ProviderSettingsTabRendererContext;
    const catalog = { refresh: jest.fn().mockResolvedValue({ changed: true }) };
    renderModels(container, context, catalog);
    const checkbox = within(container).getByRole('checkbox', { name: /Sonnet/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(settings.providerConfigs.claude.visibleModels).toEqual(['gateway-model']);
    expect(catalog.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(checkbox);
    await waitFor(() => expect(settings.providerConfigs.claude.visibleModels).toEqual([]));
    expect(claudeChatUIConfig.getModelOptions(settings)).toEqual([]);
  });

  it('offers manual recovery after failure without retrying automatically', async () => {
    const container = document.body.createDiv();
    const context = { plugin: { settings: { providerConfigs: { claude: { visibleModels: [] } } } } } as unknown as ProviderSettingsTabRendererContext;
    const catalog = { refresh: jest.fn().mockResolvedValue({ changed: false, diagnostics: 'Unavailable' }) };
    renderModels(container, context, catalog);
    await waitFor(() => expect(within(container).getByRole('status').textContent).toBe('Unavailable'));
    expect(within(container).queryByText(/Could not load Claude models/)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(catalog.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(within(container).getByRole('button', { name: 'Discover' }));
    await waitFor(() => expect(catalog.refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((within(container).getByRole('button', { name: /Refresh|Discover/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});

it('allows Discover after abort and detaches the closed settings observer', async () => {
  let finishOld!: () => void;
  const discover = jest.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = () => resolve({ changed: true }); }))
    .mockResolvedValue({ changed: true });
  const notify = jest.fn();
  const catalog = new ProviderModelCatalogController({
    providerId: 'claude', providerName: 'Claude',
    read: () => ({ enabled: true, models: [{ id: 'sonnet', name: 'Sonnet' }], selectedIds: ['sonnet'], aliases: {} }),
    discover, update: jest.fn(),
    host: { mutateSettings: async mutate => { await mutate({} as any); }, notifyProviderChatOptionsChanged: notify },
  });
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'claude', 'Claude', catalog);
  catalog.markStale();
  container.querySelector('details')!.open = true;
  const button = within(container).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(catalog.getSnapshot().status).toBe('ready'));
  expect(notify).not.toHaveBeenCalled();
  picker.dispose();
  const rendered = container.innerHTML;
  catalog.markStale();
  finishOld();
  await catalog.dispose();
  expect(container.innerHTML).toBe(rendered);
});

// Settings persistence uses structuredClone, which is not provided by jsdom.
globalThis.structuredClone ??= value => deserialize(serialize(value));

it.each(['selections', 'aliases'] as const)(
  'preserves overlapping model %s while the first settings save is pending', async kind => {
    const settings = { providerConfigs: { claude: {
      visibleModels: kind === 'aliases' ? ['sonnet', 'opus'] : [],
      modelAliases: {},
      discoveredModels: [{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }],
    } } };
    let finish!: () => void;
    let started!: () => void;
    const saving = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let writes = 0;
    const coordinator = new SettingsCoordinator(settings, async () => {
      if (++writes === 1) { started(); await gate; }
    });
    const notify = jest.fn();
    const host = {
      settings,
      mutateSettings: (mutation: (draft: ClaudianSettings) => void | Promise<void>) =>
        coordinator.mutate(draft => mutation(draft as unknown as ClaudianSettings)),
      notifyProviderChatOptionsChanged: notify,
    } as unknown as ProviderHost;
    const catalog = createClaudeModels(host, async () => ({ changed: false }));
    await catalog.refresh();
    const container = document.body.createDiv();
    const picker = renderProviderModelsSection(container, 'claude', 'Claude', catalog);
    expect((await axe(container)).violations).toEqual([]);
    const edit = (name: string, value: string) => {
      if (kind === 'selections') fireEvent.click(within(container).getByRole('checkbox', { name: new RegExp(name) }));
      else {
        const field = within(container).getByRole('textbox', { name: `Alias for ${name}` }) as HTMLInputElement;
        field.value = value;
        fireEvent.blur(field);
      }
    };
    edit('Sonnet', 'First');
    await saving;
    edit('Opus', 'Second');
    finish();
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    picker.dispose();
    await catalog.dispose();
    const saved = getClaudeProviderSettings(settings);
    expect(saved.visibleModels).toEqual(['sonnet', 'opus']);
    expect(saved.modelAliases).toEqual(kind === 'aliases' ? { sonnet: 'First', opus: 'Second' } : {});
    container.remove();
  },
);
