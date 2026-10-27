/** @jest-environment jsdom */

import '@test/helpers/ObsidianSettingsDOM';

import { deserialize, serialize } from 'node:v8';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Notice } from 'obsidian';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { createProviderRuntimeHost } from '@/composition/ClaudianProviderHost';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';

jest.mock('obsidian', () => jest.requireActual('../../../helpers/ObsidianSettingsDOM'));

// Obsidian's createEl applies the native type option as well as attr.
const originalCreateEl = HTMLElement.prototype.createEl;
HTMLElement.prototype.createEl = function (tag, info, callback) {
  const element = originalCreateEl.call(this, tag, info) as HTMLElement;
  if (typeof info === 'object' && typeof info.type === 'string') element.setAttribute('type', info.type);
  callback?.(element as never);
  return element as never;
};

afterEach(() => { document.body.replaceChildren(); });
afterAll(() => { HTMLElement.prototype.createEl = originalCreateEl; });

it.each(['Enter', 'Escape'])('leaves composing %s to the provider alias editor', async key => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const settings = { providerConfigs: { codex: {
    enabled: true, visibleModels: ['gateway-model'], modelAliases: {},
    discoveredModels: [{
      model: 'gateway-model', displayName: 'Gateway model', description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
    }],
  } } };
  let saved = '';
  const coordinator = new SettingsCoordinator(settings, async draft => { saved = JSON.stringify(draft); });
  const host = { settings, mutateSettings: coordinator.mutate.bind(coordinator), notifyProviderChatOptionsChanged: jest.fn() } as unknown as ProviderHost;
  const catalog = createCodexModels(createProviderRuntimeHost(host, coordinator, 'codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
  await catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'codex', 'Codex', catalog);
  const field = within(container).getByRole('textbox', { name: 'Alias for Gateway model' }) as HTMLInputElement;
  try {
    expect((await axe(container)).violations).toEqual([]);
    field.focus();
    fireEvent.compositionStart(field);
    fireEvent.input(field, { target: { value: 'unfinished' }, isComposing: true });
    expect(fireEvent.keyDown(field, { key, isComposing: true })).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('unfinished');
    await coordinator.persistCurrent();
    expect(getCodexProviderSettings(JSON.parse(saved)).modelAliases).toEqual({});
    fireEvent.compositionEnd(field);
    fireEvent.input(field, { target: { value: '完成' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(getCodexProviderSettings(settings).modelAliases['gateway-model']).toBe('完成'));
    expect(getCodexProviderSettings(JSON.parse(saved)).modelAliases['gateway-model']).toBe('完成');
  } finally {
    picker.dispose(); await catalog.dispose(); container.remove();
  }
});

it.each(['constructor', 'toString', '__proto__'])('edits and clears an alias for a prototype-named model %s', async modelId => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const settings = { providerConfigs: { codex: {
    enabled: true, visibleModels: [modelId], modelAliases: {},
    discoveredModels: [{
      model: modelId, displayName: 'Gateway model', description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
    }],
  } } };
  let saved = '';
  const coordinator = new SettingsCoordinator(settings, async draft => { saved = JSON.stringify(draft); });
  const notify = jest.fn();
  const host = {
    settings, mutateSettings: coordinator.mutate.bind(coordinator), notifyProviderChatOptionsChanged: notify,
  } as unknown as ProviderHost;
  const catalog = createCodexModels(createProviderRuntimeHost(host, coordinator, 'codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
  await catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'codex', 'Codex', catalog);
  const aliasField = () => within(container).getByRole('textbox', { name: 'Alias for Gateway model' }) as HTMLInputElement;
  try {
    expect(aliasField().value).toBe('');
    expect((await axe(container)).violations).toEqual([]);
    aliasField().focus();
    fireEvent.input(aliasField(), { target: { value: ' Friendly name ' } });
    fireEvent.keyDown(aliasField(), { key: 'Enter' });
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const committed = getCodexProviderSettings(settings).modelAliases;
    expect(Object.hasOwn(committed, modelId)).toBe(true);
    expect(committed[modelId]).toBe('Friendly name');
    expect(getCodexProviderSettings(JSON.parse(saved)).modelAliases[modelId]).toBe('Friendly name');
    expect(aliasField().value).toBe('Friendly name');
    aliasField().focus();
    fireEvent.input(aliasField(), { target: { value: 'Uncommitted' } });
    fireEvent.keyDown(aliasField(), { key: 'Escape' });
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(aliasField().value).toBe('Friendly name');
    aliasField().focus();
    fireEvent.input(aliasField(), { target: { value: '' } });
    fireEvent.keyDown(aliasField(), { key: 'Enter' });
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(3));
    expect(Object.hasOwn(getCodexProviderSettings(settings).modelAliases, modelId)).toBe(false);
    expect(aliasField().value).toBe('');
    aliasField().focus();
    fireEvent.input(aliasField(), { target: { value: 'Discard' } });
    fireEvent.keyDown(aliasField(), { key: 'Escape' });
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(4));
    expect(aliasField().value).toBe('');
  } finally {
    picker.dispose(); await catalog.dispose(); container.remove();
  }
});

it('retains a failed alias draft across refresh and allows a successful retry', async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const settings = { providerConfigs: { codex: {
    enabled: true, visibleModels: ['gateway-model'], modelAliases: {},
    discoveredModels: [{
      model: 'gateway-model', displayName: 'Gateway model', description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
    }],
  } } };
  let rejectSave!: (reason: Error) => void;
  const save = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  const persist = jest.fn().mockImplementationOnce(async () => save).mockResolvedValue(undefined);
  const coordinator = new SettingsCoordinator(settings, persist);
  const host = { settings, mutateSettings: coordinator.mutate.bind(coordinator), notifyProviderChatOptionsChanged: jest.fn() } as unknown as ProviderHost;
  const catalog = createCodexModels(createProviderRuntimeHost(host, coordinator, 'codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
  await catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'codex', 'Codex', catalog);
  const aliasField = () => within(container).getByRole('textbox', { name: 'Alias for Gateway model' }) as HTMLInputElement;
  try {
    aliasField().focus();
    fireEvent.input(aliasField(), { target: { value: 'My alias draft' } });
    fireEvent.keyDown(aliasField(), { key: 'Enter' });
    rejectSave(new Error('settings storage unavailable'));
    await new Promise(resolve => setTimeout(resolve, 0));
    picker.refresh();
    expect(aliasField().value).toBe('My alias draft');
    expect(Notice).toHaveBeenCalledWith('Could not save model alias. Try again.');
    expect(getCodexProviderSettings(settings).modelAliases).toEqual({});
    expect((await axe(container)).violations).toEqual([]);
    aliasField().focus();
    fireEvent.keyDown(aliasField(), { key: 'Enter' });
    await waitFor(() => expect(getCodexProviderSettings(settings).modelAliases['gateway-model']).toBe('My alias draft'));
    picker.refresh();
    expect(aliasField().value).toBe('My alias draft');
    expect(persist).toHaveBeenCalledTimes(2);
  } finally {
    picker.dispose(); await catalog.dispose(); container.remove();
  }
});
