/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createObsidianPlugin } from '@test/helpers/ObsidianSettingsHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

it.each(['Enter', 'Escape'])('leaves composing %s to the custom model alias editor', async key => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  let saved = '';
  const { settings, coordinator, host: plugin } = await createFeatureHostFixture({
    settings: { providerConfigs: { claude: { modelAliases: {}, environmentVariables: 'ANTHROPIC_MODEL=custom-model' } } },
    beforePersist: draft => { saved = JSON.stringify(draft); },
  });
  const tab = new ClaudianSettingTab(plugin.app, createObsidianPlugin(plugin.app), plugin);
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
  let release!: () => void;
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const notify = vi.fn();
  const { settings, coordinator, host: plugin } = await createFeatureHostFixture({
    settings: { providerConfigs: { claude: { modelAliases: {}, environmentVariables: 'ANTHROPIC_MODEL=custom-model' } } },
    beforePersist: async () => { if (++writes === 1) { started(); await gate; } },
    overrides: { notifyProviderChatOptionsChanged: notify },
  });
  const tab = new ClaudianSettingTab(plugin.app, createObsidianPlugin(plugin.app), plugin);
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
  const { settings, coordinator, host: plugin, settingsStorage: storage } = await createFeatureHostFixture({
    settings: { providerConfigs: { claude: {
      visibleModels: ['__proto__', 'constructor'],
      environmentVariables: 'ANTHROPIC_MODEL=__proto__\nANTHROPIC_DEFAULT_SONNET_MODEL=constructor',
    } } },
  });
  const tab = new ClaudianSettingTab(plugin.app, createObsidianPlugin(plugin.app), plugin);
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
  const persist = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);
  const notify = vi.fn();
  const { settings, host: plugin } = await createFeatureHostFixture({
    settings: { providerConfigs: { claude: { modelAliases: {}, environmentVariables: 'ANTHROPIC_MODEL=custom-model' } } },
    beforePersist: persist, overrides: { notifyProviderChatOptionsChanged: notify },
  });
  const tab = new ClaudianSettingTab(plugin.app, createObsidianPlugin(plugin.app), plugin);
  const container = document.body.appendChild(document.createElement('div'));
  const field = () => within(container).getByRole<HTMLInputElement>('textbox', { name: 'Alias for custom-model' });
  try {
    tab['renderCustomContextLimits'](container, 'claude');
    field().focus();
    fireEvent.input(field(), { target: { value: 'My custom alias' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Could not save model alias. Try again.'));
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
