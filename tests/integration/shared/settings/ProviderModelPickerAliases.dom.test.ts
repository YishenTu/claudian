/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { setLocale } from '@/i18n/i18n';
import { createCodexModels } from '@/providers/codex/runtime/CodexModels';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';

afterEach(() => { setLocale('en'); vi.mocked(Notice).mockClear(); document.body.replaceChildren(); });

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

it.each([
  { locale: 'en', label: 'Alias for Gateway model', failure: 'Could not save model alias. Try again.' },
  { locale: 'zh-CN', label: 'Gateway model 的别名', failure: '无法保存模型别名。请重试。' },
] as const)('retains a failed $locale alias draft across refresh and allows a successful retry', async ({ locale, label, failure }) => {
  setLocale(locale);
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
  let armed = false;
  const persist = vi.fn(async () => { if (armed) { armed = false; await save; } });
  const { settings, host, coordinator, settingsStorage, dispose } = await createProviderHostFixture({ settings: initialSettings, beforePersist: persist });
  const catalog = createCodexModels(host.getRuntimeHost('codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
  await catalog.refresh();
  await coordinator.persistCurrent();
  armed = true;
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'codex', 'Codex', catalog);
  const aliasField = () => within(container).getByRole('textbox', { name: label }) as HTMLInputElement;
  try {
    aliasField().focus();
    fireEvent.input(aliasField(), { target: { value: 'My alias draft' } });
    fireEvent.keyDown(aliasField(), { key: 'Enter' });
    rejectSave(new Error('settings storage unavailable'));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith(failure));
    picker.refresh();
    expect(aliasField().value).toBe('My alias draft');
    expect(Notice).toHaveBeenCalledWith(failure);
    expect(getCodexProviderSettings(settings).modelAliases).toEqual({});
    expect((await axe(container)).violations).toEqual([]);
    aliasField().focus();
    fireEvent.keyDown(aliasField(), { key: 'Enter' });
    await waitFor(() => expect(getCodexProviderSettings(settings).modelAliases['gateway-model']).toBe('My alias draft'));
    picker.refresh();
    expect(aliasField().value).toBe('My alias draft');
    expect(getCodexProviderSettings(await settingsStorage.load()).modelAliases['gateway-model']).toBe('My alias draft');
    expect(persist).toHaveBeenCalledTimes(3);
  } finally {
    rejectSave(new Error('cleanup'));
    picker.dispose(); await catalog.dispose(); await dispose(); container.remove();
  }
});

it('localizes selection failure and retries the current control against real storage', async () => {
  setLocale('zh-CN');
  let fail = false;
  let started!: () => void;
  let rejectSave!: (error: Error) => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  const fixture = await createProviderHostFixture({
    settings: { locale: 'zh-CN', providerConfigs: { codex: {
      enabled: true, visibleModels: ['gateway-model'], modelAliases: {},
      discoveredModels: ['gateway-model', 'save-model'].map(model => ({ model,
        displayName: model === 'gateway-model' ? 'Gateway model' : 'Save', description: 'Raw English description',
        supportedReasoningEfforts: [{ value: 'high', description: 'High' }], defaultReasoningEffort: 'high',
      })),
    } } },
    beforePersist: async () => { if (fail) { started(); await blocked; } },
  });
  const catalog = createCodexModels(fixture.host.getRuntimeHost('codex'), { refresh: async () => ({ kind: 'skipped', models: [], refreshed: false }) });
  await catalog.refresh();
  await fixture.coordinator.persistCurrent();
  const original = structuredClone(getCodexProviderSettings(fixture.settings));
  const storedOriginal = getCodexProviderSettings(await fixture.settingsStorage.load());
  const container = document.body.createDiv();
  const picker = renderProviderModelsSection(container, 'codex', 'Codex', catalog);
  const details = container.querySelector('details')!;
  details.open = true;
  const checkbox = () => within(container).getByRole<HTMLInputElement>('checkbox', { name: /Save save-model Raw English description/ });
  try {
    expect(checkbox().value).toBe('save-model');
    expect(checkbox().checked).toBe(false);
    fail = true;
    fireEvent.change(checkbox(), { target: { checked: true } });
    await saving;
    rejectSave(new Error('storage unavailable'));
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法保存模型选择。请重试。'));
    expect(checkbox().checked).toBe(false);
    expect(catalog.getSnapshot().selectedIds).toEqual(['gateway-model']);
    expect(getCodexProviderSettings(fixture.settings)).toEqual(original);
    expect(getCodexProviderSettings(await fixture.settingsStorage.load())).toEqual(storedOriginal);
    fail = false;
    fireEvent.change(checkbox(), { target: { checked: true } });
    await waitFor(() => expect(catalog.getSnapshot().selectedIds).toEqual(['gateway-model', 'save-model']));
    expect(checkbox().checked).toBe(true);
    expect(getCodexProviderSettings(fixture.settings).visibleModels).toEqual(['gateway-model', 'save-model']);
    expect(getCodexProviderSettings(await fixture.settingsStorage.load()).visibleModels).toEqual(['gateway-model', 'save-model']);
    expect(await axe(container)).toHaveNoViolations();
  } finally { fail = false; rejectSave(new Error('cleanup')); picker.dispose(); await catalog.dispose(); await fixture.dispose(); container.remove(); }
});
