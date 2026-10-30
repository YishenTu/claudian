/** @vitest-environment jsdom */

import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ClaudianSettings } from '@/core/types';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import type { ClaudeModelDiscovery } from '@/providers/claude/runtime/ClaudeModels';
import { createClaudeModels } from '@/providers/claude/runtime/ClaudeModels';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { claudeChatUIConfig } from '@/providers/claude/ui/ClaudeChatUIConfig';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';
import { ModelSelector } from '@/shared/toolbar/ModelSelector';
import { ToolbarMenuGroup } from '@/shared/toolbar/ToolbarMenu';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren();
});

function renderModels(container: HTMLElement, plugin: ProviderHost, native: { refresh: ClaudeModelDiscovery }) {
  const catalog = createClaudeModels(plugin.getRuntimeHost('claude'), signal => native.refresh(signal));
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', catalog);
  cleanups.push(async () => { picker.dispose(); await catalog.dispose(); });
  return picker;
}

describe('Claude model picker', () => {

  it.each(['default', 'claude-code/default'])('hides saved %s from management and chat choices', async (savedId) => {
    const container = document.body.createDiv();
    const initialSettings = { model: 'opus', providerConfigs: { claude: {
      visibleModels: [savedId, 'opus'],
      discoveredModels: [
        { value: 'default', label: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
        { value: 'opus', label: 'Opus', resolvedModel: 'claude-opus-5-5' },
      ],
    } } };
    const { host, settings } = await createProviderHostFixture({ settings: initialSettings });
    renderModels(container, host, { refresh: vi.fn().mockResolvedValue({ changed: false }) });
    await waitFor(() => expect((within(container).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(container).queryByRole('checkbox', { name: /default/i })).toBeNull();
    expect(within(container).getAllByRole('checkbox')).toEqual([within(container).getByRole('checkbox', { name: /Opus/ })]);
    expect(within(container).queryByRole('button', { name: /Reorder .*default/i })).toBeNull();
    expect(claudeChatUIConfig.getModelOptions(settings).map(model => model.value)).toEqual(['opus']);
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('opus');
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual([savedId, 'opus']);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('loads on opening the panel, refreshes manually, and uses selected order as default', async () => {
    const container = document.body.createDiv();
    const config = { discoveredModels: [] as Array<{value: string; label: string; description: string}>, visibleModels: [] as string[] };
    const initialSettings = { providerConfigs: { claude: config } };
    const { host, settings } = await createProviderHostFixture({ settings: initialSettings });
    const probe = vi.fn(async () => ({ models: [
      { value: 'gateway-model', label: 'Gateway model', description: 'From SDK' },
      { value: 'sonnet', label: 'Sonnet', description: 'From SDK' },
    ], outputStyles: [] }));
    const workspace = await createClaudeWorkspaceServices(host, { catalogProbe: probe });
    const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', workspace.modelCatalog!);
    cleanups.push(async () => { picker.dispose(); await workspace.dispose(); });
    await waitFor(() => expect((within(container).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false));
    expect(probe).toHaveBeenCalledTimes(1);
    fireEvent.click(within(container).getByRole('checkbox', { name: /Gateway model/ }));
    await waitFor(() => expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['gateway-model']));
    fireEvent.click(within(container).getByRole('checkbox', { name: /Sonnet/ }));
    await waitFor(() => expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['gateway-model', 'sonnet']));
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('claude-code/gateway-model');
    fireEvent.keyDown(within(container).getByRole('button', { name: /Reorder Sonnet/ }), { key: 'ArrowUp' });
    await waitFor(() => expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['sonnet', 'gateway-model']));
    expect(claudeChatUIConfig.getDefaultModel?.(settings)).toBe('sonnet');
    expect(probe).toHaveBeenCalledTimes(1);
    fireEvent.click(within(container).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((within(container).getByRole('button', { name: /Refresh|Discover/ }) as HTMLButtonElement).disabled).toBe(false));
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps chat order and keyboard focus aligned through repeated reorders', async () => {
    const persisted: string[][] = [];
    const h = await continuityHarness(async draft => {
      persisted.push([...getClaudeProviderSettings(draft).visibleModels!]);
    });
    await h.catalog.refresh();
    const container = document.body.createDiv();
    const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
    const toolbar = document.body.createDiv();
    const group = new ToolbarMenuGroup();
    cleanups.push(() => group.destroy());
    const selector = new ModelSelector(toolbar, {
      getSettings: () => ({ ...h.settings, reasoning: h.settings.effortLevel }), getUIConfig: () => claudeChatUIConfig,
      getCapabilities: () => ProviderRegistry.getCapabilities('claude'),
      onModelChange: async () => { throw new Error('Unexpected model selection'); },
      onEffortLevelChange: async () => { throw new Error('Unexpected effort change'); },
    }, group);
    const chatLabels = () => [...toolbar.querySelectorAll('.claudian-model-option')].map(el => el.textContent);
    const handle = (name: string) => within(container).getByRole('button', {
      name: `Reorder ${name}; drag or use the Up and Down Arrow keys`,
    });
    try {
      expect(chatLabels()).toEqual(['Sonnet', 'Opus', 'Gateway model']);
      fireEvent.keyDown(handle('Opus'), { key: 'ArrowUp' });
      await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
      await settleCallbacks();
      expect(getClaudeProviderSettings(h.settings).visibleModels).toEqual(['opus', 'sonnet', 'gateway-model']);
      selector.renderOptions();
      expect(chatLabels()).toEqual(['Opus', 'Sonnet', 'Gateway model']);
      expect(claudeChatUIConfig.getDefaultModel?.(h.settings)).toBe('opus');
      fireEvent.keyDown(handle('Opus'), { key: 'ArrowDown' });
      await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(2));
      await settleCallbacks();
      expect(getClaudeProviderSettings(h.settings).visibleModels).toEqual(['sonnet', 'opus', 'gateway-model']);
      handle('Gateway model').focus();
      expect(document.activeElement).toBe(handle('Gateway model'));
      for (const [index, order] of [
        ['sonnet', 'gateway-model', 'opus'], ['gateway-model', 'sonnet', 'opus'],
      ].entries()) {
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
        await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(index + 3));
        await settleCallbacks();
        expect(getClaudeProviderSettings(h.settings).visibleModels).toEqual(order);
        expect(document.activeElement).toBe(handle('Gateway model'));
        expect([...container.querySelectorAll('[data-model-id]')].map(row => row.getAttribute('data-model-id'))).toEqual(order);
        selector.renderOptions();
        expect(chatLabels()).toEqual(index === 0 ? ['Sonnet', 'Gateway model', 'Opus'] : ['Gateway model', 'Sonnet', 'Opus']);
        expect(claudeChatUIConfig.getDefaultModel?.(h.settings)).toBe(index === 0 ? 'sonnet' : 'claude-code/gateway-model');
      }
      expect(persisted.slice(2)).toEqual([
        ['sonnet', 'gateway-model', 'opus'], ['gateway-model', 'sonnet', 'opus'],
      ]);
    } finally {
      picker.dispose(); await h.catalog.dispose(); container.remove(); toolbar.remove();
    }
  });

  it('shows manual refresh guidance and clears it when the selected model becomes available', () => {
    const toolbar = document.body.createDiv();
    const settings = { model: 'sonnet', providerConfigs: { claude: {
      visibleModels: ['sonnet'], discoveredModels: [] as Array<{ value: string; label: string }>,
    } } };
    const group = new ToolbarMenuGroup();
    cleanups.push(() => group.destroy());
    const selector = new ModelSelector(toolbar, {
      getSettings: () => ({ ...settings, reasoning: null }), getUIConfig: () => claudeChatUIConfig,
      getCapabilities: () => ProviderRegistry.getCapabilities('claude'),
      onModelChange: async () => { throw new Error('Unexpected model selection'); },
      onEffortLevelChange: async () => { throw new Error('Unexpected effort change'); },
    }, group);
    expect(within(toolbar).getByText('Model unavailable').parentElement?.title).toMatch(/refresh/i);
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Model unavailable' }));
    expect(within(toolbar).getByRole('status').textContent).toMatch(/refresh/i);
    settings.providerConfigs.claude.discoveredModels = [{ value: 'sonnet', label: 'Sonnet' }];
    selector.updateDisplay();
    expect(within(toolbar).getByText('Sonnet').parentElement?.title).toBe('');
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Model: Sonnet' }));
  });

  it('projects a saved native ID onto its SDK row without rewriting the saved choice', async () => {
    const container = document.body.createDiv();
    const initialSettings = { providerConfigs: { claude: {
      visibleModels: ['gateway-model'],
      discoveredModels: [{ value: 'sonnet', label: 'Sonnet', description: '', resolvedModel: 'gateway-model' }],
    } } };
    const { host, settings } = await createProviderHostFixture({ settings: initialSettings });
    const catalog = { refresh: vi.fn().mockResolvedValue({ changed: true }) };
    renderModels(container, host, catalog);
    const checkbox = within(container).getByRole('checkbox', { name: /Sonnet/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(getClaudeProviderSettings(settings).visibleModels).toEqual(['gateway-model']);
    expect(catalog.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(checkbox);
    await waitFor(() => expect(getClaudeProviderSettings(settings).visibleModels).toEqual([]));
    expect(claudeChatUIConfig.getModelOptions(settings)).toEqual([]);
  });

  it('offers manual recovery after failure without retrying automatically', async () => {
    const container = document.body.createDiv();
    const { host } = await createProviderHostFixture({ settings: { providerConfigs: { claude: { visibleModels: [] } } } });
    const catalog = { refresh: vi.fn().mockResolvedValue({ changed: false, diagnostics: 'Unavailable' }) };
    renderModels(container, host, catalog);
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
  const discover = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = () => resolve({ changed: true }); }))
    .mockResolvedValue({ changed: true });
  const notify = vi.fn();
  const catalog = new ProviderModelCatalogController({
    providerName: 'Claude Code', discover,
    store: {
      read: () => ({ enabled: true, models: [{ id: 'sonnet', name: 'Sonnet' }], selectedIds: ['sonnet'], aliases: {} }),
      write: async () => undefined,
      notifyChatOptionsChanged: notify,
    },
  });
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', catalog);
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
    const fixture = await createProviderHostFixture({ settings, beforePersist: async () => {
      if (++writes === 1) { started(); await gate; }
    } });
    const notify = vi.spyOn(fixture.host, 'notifyProviderChatOptionsChanged');
    const catalog = createClaudeModels(fixture.host.getRuntimeHost('claude'), async () => ({ changed: false }));
    await catalog.refresh();
    const container = document.body.createDiv();
    const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', catalog);
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
    const saved = getClaudeProviderSettings(fixture.settings);
    expect(saved.visibleModels).toEqual(['sonnet', 'opus']);
    expect(saved.modelAliases).toEqual(kind === 'aliases' ? { sonnet: 'First', opus: 'Second' } : {});
    container.remove();
  },
);

it('restores committed model checkboxes after a failed selection save and allows retry', async () => {
  let rejectSave = true;
  let saved = '';
  const h = await continuityHarness(async draft => {
    if (rejectSave) throw new Error('Disk is read-only');
    saved = JSON.stringify(draft);
  });
  await h.catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
  container.querySelector('details')!.open = true;
  const checkbox = () => within(container).getByRole('checkbox', { name: /Gateway model/ }) as HTMLInputElement;
  vi.mocked(Notice).mockClear();
  try {
    checkbox().focus();
    fireEvent.click(checkbox());
    await waitFor(() => expect(checkbox().checked).toBe(true));
    expect(getClaudeProviderSettings(h.settings).visibleModels).toEqual(['sonnet', 'opus', 'gateway-model']);
    expect(Notice).toHaveBeenCalledWith('Could not save model selection. Try again.');
    expect(h.notify).not.toHaveBeenCalled();
    rejectSave = false;
    fireEvent.click(checkbox());
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(checkbox().checked).toBe(false);
    expect(getClaudeProviderSettings(JSON.parse(saved)).visibleModels).toEqual(['sonnet', 'opus']);
    expect((await axe(container)).violations).toEqual([]);
  } finally {
    picker.dispose(); await h.catalog.dispose(); container.remove();
  }
});

async function continuityHarness(persist: (draft: ClaudianSettings) => Promise<void>) {
  const fixture = await createProviderHostFixture({
    settings: { model: 'opus', providerConfigs: { claude: {
      visibleModels: ['sonnet', 'opus', 'gateway-model'], modelAliases: {},
      discoveredModels: [
        { value: 'opus', label: 'Opus' }, { value: 'gateway-model', label: 'Gateway model' },
        { value: 'sonnet', label: 'Sonnet' },
      ],
    } } }, beforePersist: persist,
  });
  const notify = vi.spyOn(fixture.host, 'notifyProviderChatOptionsChanged');
  return { ...fixture, notify, catalog: createClaudeModels(fixture.host.getRuntimeHost('claude'), async () => ({ changed: false })) };
}

async function settleCallbacks() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

it.each([false, true])('preserves an uncommitted focused alias across another save (native removal blur: %s)', async nativeRemovalBlur => {
  let finish!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let writes = 0;
  const h = await continuityHarness(async () => { if (++writes === 1) { started(); await gate; } });
  await h.catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
  const originalEmpty = HTMLElement.prototype.empty;
  // jsdom omits the native dirty-input blur measured during Obsidian DOM removal.
  if (nativeRemovalBlur) HTMLElement.prototype.empty = function () {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && this.contains(active)) active.blur();
    originalEmpty.call(this);
  };
  try {
    const sonnet = within(container).getByRole('textbox', { name: 'Alias for Sonnet' }) as HTMLInputElement;
    const opus = within(container).getByRole('textbox', { name: 'Alias for Opus' }) as HTMLInputElement;
    sonnet.focus();
    fireEvent.input(sonnet, { target: { value: 'First' } });
    opus.focus();
    await saving;
    expect(document.activeElement).toBe(opus);
    fireEvent.input(opus, { target: { value: 'Second' } });
    opus.setSelectionRange(2, 4);
    expect([opus.value, opus.selectionStart, opus.selectionEnd]).toEqual(['Second', 2, 4]);
    expect(getClaudeProviderSettings(h.settings).modelAliases).toEqual({});
    finish();
    await waitFor(() => expect(h.notify.mock.calls.length).toBeGreaterThanOrEqual(1));
    await settleCallbacks();
    const current = container.querySelector('[data-model-id="opus"] input') as HTMLInputElement;
    expect(current.isConnected).toBe(true);
    expect({ focused: document.activeElement === current, draft: current.value,
      caret: [current.selectionStart, current.selectionEnd],
      savedAliases: getClaudeProviderSettings(h.settings).modelAliases, writes,
    }).toEqual({ focused: true, draft: 'Second', caret: [2, 4], savedAliases: { sonnet: 'First' }, writes: 1 });
    current.blur();
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(2));
    await settleCallbacks();
    expect(getClaudeProviderSettings(h.settings).modelAliases).toEqual({ sonnet: 'First', opus: 'Second' });
    expect(writes).toBe(2);
  } finally {
    HTMLElement.prototype.empty = originalEmpty;
    finish(); picker.dispose(); await h.catalog.dispose(); container.remove();
  }
});

it.each(['outside focus', 'disposed'] as const)('does not restore an older alias interaction after %s', async lifecycle => {
  let finish!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const h = await continuityHarness(async () => { started(); await gate; });
  await h.catalog.refresh();
  const container = document.body.createDiv();
  const outside = document.body.createEl('button', { text: 'Outside settings' });
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
  const field = within(container).getByRole('textbox', { name: 'Alias for Sonnet' }) as HTMLInputElement;
  field.focus();
  fireEvent.input(field, { target: { value: 'First' } });
  outside.focus();
  await saving;
  if (lifecycle === 'disposed') { picker.dispose(); container.remove(); }
  const rendered = container.innerHTML;
  const mutations = vi.fn();
  const observer = new MutationObserver(mutations);
  observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    finish();
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    await settleCallbacks();
    expect(document.activeElement).toBe(outside);
    expect(getClaudeProviderSettings(h.settings).modelAliases).toEqual({ sonnet: 'First' });
    expect(container.isConnected).toBe(lifecycle === 'outside focus');
    expect(container.innerHTML === rendered).toBe(lifecycle === 'disposed');
    expect(mutations.mock.calls.length === 0).toBe(lifecycle === 'disposed');
  } finally {
    observer.disconnect(); finish(); picker.dispose(); await h.catalog.dispose(); container.remove(); outside.remove();
  }
});

it.each(['remove', 'clear'] as const)('discards a focused draft when its selection is removed by %s', async action => {
  let finish!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let writes = 0;
  const h = await continuityHarness(async () => { if (++writes === 1) { started(); await gate; } });
  await h.catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
  try {
    const sonnet = within(container).getByRole('textbox', { name: 'Alias for Sonnet' }) as HTMLInputElement;
    const opus = within(container).getByRole('textbox', { name: 'Alias for Opus' }) as HTMLInputElement;
    sonnet.focus(); fireEvent.input(sonnet, { target: { value: 'First' } });
    opus.focus(); await saving;
    fireEvent.input(opus, { target: { value: 'Discard me' } });
    expect(document.activeElement).toBe(opus);
    fireEvent.click(within(container).getByRole('button', {
      name: action === 'remove' ? 'Remove Opus' : 'Clear all selected Claude Code models',
    }));
    finish();
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(2));
    await settleCallbacks();
    expect(getClaudeProviderSettings(h.settings).visibleModels).toEqual(action === 'remove' ? ['sonnet', 'gateway-model'] : []);
    expect(container.querySelector('[data-model-id="opus"]')).toBeNull();
    expect(within(container).queryByDisplayValue('Discard me')).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(getClaudeProviderSettings(h.settings).modelAliases).toEqual({ sonnet: 'First' });
    expect(writes).toBe(2);
  } finally {
    finish(); picker.dispose(); await h.catalog.dispose(); container.remove();
  }
});

it('refreshes clean authoritative fields and uses the latest committed alias on Escape', async () => {
  const h = await continuityHarness(async () => {});
  await h.catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
  const opusField = () => container.querySelector('[data-model-id="opus"] input') as HTMLInputElement;
  try {
    opusField().focus();
    await h.coordinator.mutate(draft => {
      const config = getClaudeProviderSettings(draft);
      updateClaudeProviderSettings(draft, { modelAliases: { opus: 'Official' }, visibleModels: ['opus', 'sonnet', 'gateway-model'],
        discoveredModels: config.discoveredModels.map((model, index) => index === 0 ? { ...model, label: 'Updated Opus' } : model) });
    });
    h.catalog.markStale();
    expect(opusField().value).toBe('Official');
    expect(opusField().placeholder).toBe('Official');
    expect(document.activeElement).toBe(opusField());
    expect([...container.querySelectorAll('[data-model-id]')].map(row => row.getAttribute('data-model-id'))).toEqual(['opus', 'sonnet', 'gateway-model']);
    fireEvent.input(opusField(), { target: { value: 'Unsaved' } });
    await h.coordinator.mutate(draft => {
      updateClaudeProviderSettings(draft, { modelAliases: { opus: 'Official', sonnet: 'Other' } });
    });
    h.catalog.markStale();
    expect(opusField().value).toBe('Unsaved');
    expect(document.activeElement).toBe(opusField());
    // Escape reads the current authority even before another panel refresh.
    await h.coordinator.mutate(draft => { updateClaudeProviderSettings(draft, { modelAliases: { opus: 'Latest' } }); });
    fireEvent.keyDown(opusField(), { key: 'Escape' });
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    await settleCallbacks();
    expect(opusField().value).toBe('Latest');
    expect(getClaudeProviderSettings(h.settings).modelAliases).toEqual({ opus: 'Latest' });
    opusField().focus(); fireEvent.input(opusField(), { target: { value: 'Entered' } });
    fireEvent.keyDown(opusField(), { key: 'Enter' });
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(2));
    await settleCallbacks();
    expect(getClaudeProviderSettings(h.settings).modelAliases).toEqual({ opus: 'Entered' });
    expect(opusField().value).toBe('Entered');
    await h.coordinator.mutate(draft => { updateClaudeProviderSettings(draft, { modelAliases: {} }); });
    h.catalog.markStale();
    expect(opusField().value).toBe('');
    expect(opusField().placeholder).toBe('Updated Opus');
    expect(within(container).getByRole('button', { name: 'Remove Updated Opus' })).toBeTruthy();
    await h.coordinator.mutate(draft => {
      updateClaudeProviderSettings(draft, { discoveredModels: getClaudeProviderSettings(draft).discoveredModels.filter(model => model.value !== 'opus') });
    });
    h.catalog.markStale();
    expect(container.querySelector('[data-model-id="opus"]')).not.toBeNull();
    expect(within(container).getByText('Not currently reported by Claude Code')).toBeTruthy();
    expect(claudeChatUIConfig.getDefaultModel?.(h.settings)).toBe('sonnet');
    expect((await axe(container)).violations).toEqual([]);
  } finally {
    picker.dispose(); await h.catalog.dispose(); container.remove();
  }
});

it('keeps the catalog checkbox focused after selecting and deselecting a model', async () => {
  const h = await continuityHarness(async () => {});
  await h.catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
  container.querySelector('details')!.open = true;
  const checkbox = () => within(container).getByRole('checkbox', { name: /Gateway model/ }) as HTMLInputElement;
  try {
    checkbox().focus();
    for (const selected of [false, true, false]) {
      fireEvent.click(checkbox());
      await waitFor(() => expect(getClaudeProviderSettings(h.settings).visibleModels?.includes('gateway-model')).toBe(selected));
      await settleCallbacks();
      expect(checkbox().checked).toBe(selected);
      expect(document.activeElement).toBe(checkbox());
    }
    expect((await axe(container)).violations).toEqual([]);
  } finally {
    picker.dispose(); await h.catalog.dispose(); container.remove();
  }
});

it('does not take focus back to a catalog checkbox when its pending selection finishes', async () => {
  let finish!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const h = await continuityHarness(async () => { started(); await gate; });
  await h.catalog.refresh();
  const container = document.body.createDiv();
  const outside = document.body.createEl('button', { text: 'Outside catalog' });
  const picker = renderProviderModelsSection(container, 'claude', 'Claude Code', h.catalog);
  container.querySelector('details')!.open = true;
  try {
    const checkbox = within(container).getByRole('checkbox', { name: /Gateway model/ });
    checkbox.focus();
    fireEvent.click(checkbox);
    await saving;
    outside.focus();
    finish();
    await waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    await settleCallbacks();
    expect(document.activeElement).toBe(outside);
    expect((within(container).getByRole('checkbox', { name: /Gateway model/ }) as HTMLInputElement).checked).toBe(false);
  } finally {
    finish(); picker.dispose(); await h.catalog.dispose(); container.remove(); outside.remove();
  }
});
