/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';

afterEach(() => { document.body.replaceChildren(); });

it.each(['Enter', 'Escape'])('leaves composing %s to the provider alias editor', async key => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const initialSettings = { providerConfigs: { codex: {
    enabled: true, visibleModels: ['gateway-model'], modelAliases: {},
    discoveredModels: [{
      model: 'gateway-model', displayName: 'Gateway model', description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
    }],
  } } };
  let saved = '';
  const { settings, coordinator, host } = await createProviderHostFixture({
    settings: initialSettings, beforePersist: draft => { saved = JSON.stringify(draft); },
  });
  const catalog = createCodexModels(host.getRuntimeHost('codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
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
  const initialSettings = { providerConfigs: { codex: {
    enabled: true, visibleModels: [modelId], modelAliases: {},
    discoveredModels: [{
      model: modelId, displayName: 'Gateway model', description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
    }],
  } } };
  let saved = '';
  const notify = vi.fn();
  const { settings, host } = await createProviderHostFixture({
    settings: initialSettings, beforePersist: draft => { saved = JSON.stringify(draft); },
    overrides: { notifyProviderChatOptionsChanged: notify },
  });
  const catalog = createCodexModels(host.getRuntimeHost('codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
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
  const initialSettings = { providerConfigs: { codex: {
    enabled: true, visibleModels: ['gateway-model'], modelAliases: {},
    discoveredModels: [{
      model: 'gateway-model', displayName: 'Gateway model', description: '',
      supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
    }],
  } } };
  let rejectSave!: (reason: Error) => void;
  const save = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  const persist = vi.fn().mockImplementationOnce(async () => save).mockResolvedValue(undefined);
  const { settings, host } = await createProviderHostFixture({ settings: initialSettings, beforePersist: persist });
  const catalog = createCodexModels(host.getRuntimeHost('codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
  await catalog.refresh();
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'codex', 'Codex', catalog);
  const aliasField = () => within(container).getByRole('textbox', { name: 'Alias for Gateway model' }) as HTMLInputElement;
  try {
    aliasField().focus();
    fireEvent.input(aliasField(), { target: { value: 'My alias draft' } });
    fireEvent.keyDown(aliasField(), { key: 'Enter' });
    rejectSave(new Error('settings storage unavailable'));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Could not save model alias. Try again.'));
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
