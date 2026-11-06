/** @vitest-environment jsdom */
import '@/providers';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createObsidianPlugin, mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { setLocale } from '@/i18n/i18n';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
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

it('uses the committed interface locale through public provider settings and retries an alias draft', async () => {
  setLocale('en');
  vi.mocked(Notice).mockClear();
  let fail = false;
  const fixture = await createFeatureHostFixture({
    settings: { locale: 'zh-CN', enableAutoTitleGeneration: false, settingsProvider: 'claude',
      providerConfigs: { claude: { enabled: true, modelAliases: { Save: 'Archive' }, environmentVariables: 'ANTHROPIC_MODEL=Save' } },
    },
    beforePersist: () => { if (fail) throw new Error('storage unavailable'); },
  });
  const services = await createClaudeWorkspaceServices(fixture.providerHost, { catalogProbe: async () => ({ models: [], outputStyles: [] }) });
  ProviderWorkspaceRegistry.setServices('claude', services);
  const tab = new ClaudianSettingTab(fixture.host.app, createObsidianPlugin(fixture.host.app), fixture.host);
  const container = document.body.createEl('main');
  const hide = mountSettingTab(tab, container);
  const overrides = () => within(container).getByText('自定义模型覆盖').parentElement!.parentElement!;
  const alias = () => within(overrides()).getByRole<HTMLInputElement>('textbox', { name: 'Save 的别名' });
  try {
    fireEvent.click(within(container).getByRole('button', { name: '提供商' }));
    await waitFor(() => expect(alias().value).toBe('Archive'));
    const context = within(overrides()).getByRole<HTMLInputElement>('textbox', { name: /^(Context window for Save|Save 的上下文窗口)$/ });
    expect.soft(context.getAttribute('aria-label')).toBe('Save 的上下文窗口');
    await fixture.coordinator.persistCurrent();
    fail = true;
    fireEvent.input(alias(), { target: { value: '  Context window  ' } });
    alias().focus();
    fireEvent.keyDown(alias(), { key: 'Enter' });
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('无法保存模型别名。请重试。'));
    expect(getClaudeProviderSettings(fixture.settings).modelAliases).toEqual({ Save: 'Archive' });
    expect(getClaudeProviderSettings(await fixture.settingsStorage.load()).modelAliases).toEqual({ Save: 'Archive' });
    tab.update();
    await waitFor(() => expect(alias().value).toBe('  Context window  '));
    expect(await axe(alias().parentElement!)).toHaveNoViolations();
    fail = false;
    alias().focus();
    fireEvent.keyDown(alias(), { key: 'Enter' });
    await waitFor(() => expect(getClaudeProviderSettings(fixture.settings).modelAliases).toEqual({ Save: 'Context window' }));
    expect(getClaudeProviderSettings(await fixture.settingsStorage.load()).modelAliases).toEqual({ Save: 'Context window' });
    const currentContext = within(overrides()).getByRole('textbox', { name: 'Save 的上下文窗口' });
    fireEvent.input(currentContext, { target: { value: '64k' } });
    await waitFor(() => expect(fixture.settings.customContextLimits).toEqual({ Save: 64000 }));
    expect((await fixture.settingsStorage.load()).customContextLimits).toEqual({ Save: 64000 });
  } finally {
    fail = false; hide(); await ProviderWorkspaceRegistry.disposeInitialized(); ProviderWorkspaceRegistry.clear();
    await services.dispose(); await fixture.dispose(); container.remove(); setLocale('en'); vi.mocked(Notice).mockClear();
  }
});
