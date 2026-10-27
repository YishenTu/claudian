/** @jest-environment jsdom */
import '@/providers';
import '@test/helpers/ObsidianSettingsDOM';

import { deserialize, serialize } from 'node:v8';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Notice } from 'obsidian';

import { ClaudianSettingsStorage } from '@/app/settings/ClaudianSettingsStorage';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';

// Obsidian applies native input attributes supplied through createEl options.
const originalCreateEl = HTMLElement.prototype.createEl;
HTMLElement.prototype.createEl = function (tag, info, callback) {
  const element = originalCreateEl.call(this, tag, info) as HTMLElement;
  if (typeof info === 'object') {
    for (const name of ['type', 'value', 'placeholder'] as const) {
      if (typeof info[name] === 'string') element.setAttribute(name, info[name]);
    }
  }
  callback?.(element as never);
  return element as never;
};
afterAll(() => { HTMLElement.prototype.createEl = originalCreateEl; });

it.each(['Enter', 'Escape'])('leaves composing %s to the custom model alias editor', async key => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const settings = { providerConfigs: { claude: { modelAliases: {} } } };
  let saved = '';
  const coordinator = new SettingsCoordinator(settings, async draft => { saved = JSON.stringify(draft); });
  const plugin = {
    settings,
    getActiveEnvironmentVariables: () => 'ANTHROPIC_MODEL=custom-model',
    mutateSettings: coordinator.mutate.bind(coordinator),
    notifyProviderChatOptionsChanged: jest.fn(),
    storage: { getAdapter: () => ({}) },
  };
  const tab = new ClaudianSettingTab({} as any, {} as any, plugin as any);
  const container = document.body.appendChild(document.createElement('div'));
  try {
    tab['renderCustomContextLimits'](container, 'claude');
    const field = within(container).getByRole('textbox', { name: 'Alias for custom-model' }) as HTMLInputElement;
    expect((await axe(container)).violations).toEqual([]);
    field.focus();
    fireEvent.compositionStart(field);
    fireEvent.input(field, { target: { value: 'unfinished' }, isComposing: true });
    expect(fireEvent.keyDown(field, { key, isComposing: true })).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('unfinished');
    await coordinator.persistCurrent();
    expect(getClaudeProviderSettings(JSON.parse(saved)).modelAliases).toEqual({});
    fireEvent.compositionEnd(field);
    fireEvent.input(field, { target: { value: '完成' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(getClaudeProviderSettings(settings).modelAliases['custom-model']).toBe('完成'));
    expect(getClaudeProviderSettings(JSON.parse(saved)).modelAliases['custom-model']).toBe('完成');
  } finally { container.remove(); }
});

it('keeps the latest alias edit when it restores the committed value during a pending save', async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const settings = { providerConfigs: { claude: { modelAliases: {} } } };
  let release!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const coordinator = new SettingsCoordinator(settings, async () => {
    if (++writes === 1) { started(); await gate; }
  });
  const notify = jest.fn();
  const plugin = {
    settings,
    getActiveEnvironmentVariables: () => 'ANTHROPIC_MODEL=custom-model',
    mutateSettings: coordinator.mutate.bind(coordinator),
    notifyProviderChatOptionsChanged: notify,
    storage: { getAdapter: () => ({}) },
  };
  const tab = new ClaudianSettingTab({} as any, {} as any, plugin as any);
  const container = document.body.appendChild(document.createElement('div'));
  tab['renderCustomContextLimits'](container, 'claude');
  const field = within(container).getByRole('textbox', { name: 'Alias for custom-model' }) as HTMLInputElement;
  expect((await axe(container)).violations).toEqual([]);
  field.value = 'First';
  fireEvent.blur(field);
  await saving;
  field.value = '';
  fireEvent.blur(field);
  release();
  await coordinator.persistCurrent();
  await waitFor(() => expect(getClaudeProviderSettings(settings).modelAliases).toEqual({}));
  expect(notify).toHaveBeenCalledTimes(2);
  container.remove();
});


it('persists and clears prototype-named overrides through the general custom model editor', async () => {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  updateClaudeProviderSettings(settings, { visibleModels: ['__proto__', 'constructor'] });
  let serialized = '';
  const adapter = {
    exists: async () => serialized !== '', read: async () => serialized,
    write: async (_path: string, value: string) => { serialized = value; },
  } as unknown as VaultFileAdapter;
  const storage = new ClaudianSettingsStorage(adapter, DEFAULT_CLAUDIAN_SETTINGS);
  const coordinator = new SettingsCoordinator(settings, value => storage.save(value));
  const plugin = {
    settings, mutateSettings: coordinator.mutate.bind(coordinator),
    getActiveEnvironmentVariables: () => 'ANTHROPIC_MODEL=__proto__\nANTHROPIC_DEFAULT_SONNET_MODEL=constructor',
    notifyProviderChatOptionsChanged: jest.fn(), storage: { getAdapter: () => adapter },
  };
  const tab = new ClaudianSettingTab({} as any, {} as any, plugin as any);
  const container = document.body.appendChild(document.createElement('div'));
  tab['renderCustomContextLimits'](container, 'claude');
  const initial: string[][] = [];
  const overrides = [
    ['__proto__', 'Prototype model', '200k'],
    ['constructor', 'Constructor model', '100k'],
  ];
  for (const [modelId, alias, context] of overrides) {
    const aliasInput = within(container).getByRole<HTMLInputElement>('textbox', { name: `Alias for ${modelId}` });
    const contextInput = within(container).getByRole<HTMLInputElement>('textbox', { name: `Context window for ${modelId}` });
    initial.push([aliasInput.value, contextInput.value]);
    fireEvent.input(aliasInput, { target: { value: alias } });
    fireEvent.blur(aliasInput);
    fireEvent.input(contextInput, { target: { value: context } });
  }
  await coordinator.persistCurrent();
  const expectedAliases = Object.fromEntries([['__proto__', 'Prototype model'], ['constructor', 'Constructor model']]);
  const expectedLimits = Object.fromEntries([['__proto__', 200000], ['constructor', 100000]]);
  expect(getClaudeProviderSettings(settings).modelAliases).toEqual(expectedAliases);
  expect(settings.customContextLimits).toEqual(expectedLimits);
  expect(initial).toEqual([['', ''], ['', '']]);
  const reloaded = await storage.load();
  expect(getClaudeProviderSettings(reloaded).modelAliases).toEqual(expectedAliases);
  expect(reloaded.customContextLimits).toEqual(expectedLimits);
  Object.assign(settings, reloaded);
  tab['renderCustomContextLimits'](container, 'claude');
  const aliasInput = within(container).getByRole<HTMLInputElement>('textbox', { name: 'Alias for __proto__' });
  aliasInput.focus();
  fireEvent.input(aliasInput, { target: { value: 'Unsaved draft' } });
  fireEvent.keyDown(aliasInput, { key: 'Escape' });
  await coordinator.persistCurrent();
  expect(aliasInput.value).toBe('Prototype model');
  expect(await axe(container)).toHaveNoViolations();
  for (const [modelId] of overrides) {
    const alias = within(container).getByRole('textbox', { name: `Alias for ${modelId}` });
    fireEvent.input(alias, { target: { value: '' } });
    fireEvent.blur(alias);
    fireEvent.input(within(container).getByRole('textbox', { name: `Context window for ${modelId}` }), { target: { value: '' } });
  }
  await coordinator.persistCurrent();
  const cleared = await storage.load();
  expect(getClaudeProviderSettings(cleared).modelAliases).toEqual({});
  expect(cleared.customContextLimits).toEqual({});
  container.remove();
});

it('retains a failed custom alias across rerender and allows retry', async () => {
  const settings = { providerConfigs: { claude: { modelAliases: {} } } };
  const persist = jest.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const plugin = {
    settings, getActiveEnvironmentVariables: () => 'ANTHROPIC_MODEL=custom-model',
    mutateSettings: coordinator.mutate.bind(coordinator),
    notifyProviderChatOptionsChanged: jest.fn(), storage: { getAdapter: () => ({}) },
  };
  const tab = new ClaudianSettingTab({} as any, {} as any, plugin as any);
  const container = document.body.appendChild(document.createElement('div'));
  const field = () => within(container).getByRole<HTMLInputElement>('textbox', { name: 'Alias for custom-model' });
  try {
    tab['renderCustomContextLimits'](container, 'claude');
    field().focus();
    fireEvent.input(field(), { target: { value: 'My custom alias' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await new Promise(resolve => setTimeout(resolve, 0));
    tab['renderCustomContextLimits'](container, 'claude');
    expect(field().value).toBe('My custom alias');
    expect(Notice).toHaveBeenCalledWith('Could not save model alias. Try again.');
    expect(getClaudeProviderSettings(settings).modelAliases).toEqual({});
    expect(await axe(container)).toHaveNoViolations();
    field().focus();
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(plugin.notifyProviderChatOptionsChanged).toHaveBeenCalledTimes(1));
    expect(getClaudeProviderSettings(settings).modelAliases['custom-model']).toBe('My custom alias');
    tab['renderCustomContextLimits'](container, 'claude');
    expect(field().value).toBe('My custom alias');
    expect(persist).toHaveBeenCalledTimes(2);
  } finally { container.remove(); }
});
