/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createObsidianPlugin, mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { fireEvent, within } from '@testing-library/dom';
import { Setting } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderSettingsTabRenderer } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';
import { t } from '@/i18n/i18n';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { updateClaudeProviderSettings } from '@/providers/claude/settings';
import { codexProviderRegistration } from '@/providers/codex/registration';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await ProviderWorkspaceRegistry.disposeInitialized();
  ProviderWorkspaceRegistry.clear();
  document.body.replaceChildren();
});

async function createSettings(
  overrides: Partial<ClaudianSettings> = {},
  beforePersist = async () => {},
  onCommit = (_settings: Readonly<ClaudianSettings>) => {},
) {
  const persist = vi.fn(beforePersist);
  const fixture = await createFeatureHostFixture({
    settings: {
      enableAutoTitleGeneration: false, ...overrides,
      providerConfigs: {
        claude: { enabled: true, ...claudeCatalogFixture(['sonnet']), ...overrides.providerConfigs?.claude },
        codex: { enabled: true, visibleModels: ['gpt-5.5'], discoveredModels: structuredClone(TEST_CODEX_CATALOG), ...overrides.providerConfigs?.codex },
      },
    },
    beforePersist: persist,
  });
  const { host, settings, coordinator, vault } = fixture;
  const getAdapter = vi.spyOn(fixture.storage, 'getAdapter');
  const mutate = host.mutateSettings.bind(host);
  const mutations = vi.spyOn(host, 'mutateSettings').mockImplementation(async mutation => {
    await mutate(mutation);
    onCommit(settings);
  });
  const providers = [claudeProviderRegistration, codexProviderRegistration].map(registration => {
    const { id } = registration;
    ProviderRegistry.register(id, registration);
    const render = vi.fn<ProviderSettingsTabRenderer['render']>((container, context) => {
      container.createEl('p', { text: `${id} settings loaded` });
      new Setting(container).addButton(button => button.setButtonText(`Enable ${id}`).onClick(async () => {
        await coordinator.mutate(draft => {
          draft.providerConfigs[id] = { ...draft.providerConfigs[id], enabled: true };
        });
        context.notifyProviderModelOptionsChanged(id);
      }));
    });
    const initialize = vi.fn(async () => ({ settingsTabRenderer: { render } }));
    ProviderWorkspaceRegistry.register(id, { initialize });
    return { id, initialize, render };
  });
  const container = document.body.createEl('main');
  container.textContent = 'Obsolete settings';
  const plugin = createObsidianPlugin(host.app, {
    id: 'test-settings', name: 'Test settings', author: 'Test', description: '', version: '1.0.0', minAppVersion: '1.0.0',
  });
  const tab = new ClaudianSettingTab(host.app, plugin, host);
  const dispose = mountSettingTab(tab, container);
  cleanups.push(async () => { dispose(); await coordinator.persistCurrent(); await fixture.dispose(); });
  return { vault, tab, settings, storage: fixture.settingsStorage, persist, container, host, getAdapter, providers, dispose, mutations, notifications: fixture.notifications };
}

it('renders the declarative settings surface and loads real skills only on first activation', async () => {
  const h = await createSettings();
  const [definition] = h.tab.getSettingDefinitions();
  expect(definition).toMatchObject({ name: 'Claudian', searchable: false });
  expect(h.container.querySelector('.claudian-settings')).not.toBeNull();
  expect(within(h.container).queryByText('Obsolete settings')).toBeNull();
  for (const name of ['general', 'providers', 'skills'] as const) {
    expect(within(h.container).getByRole('button', { name: t(`settings.tabs.${name}`) })).toBeDefined();
  }
  expect(within(h.container).queryByRole('button', { name: 'Projects' })).toBeNull();
  expect(h.getAdapter).not.toHaveBeenCalled();
  await h.vault.write('.agents/skills/local/SKILL.md', '---\nname: local\ndescription: Local skill\n---\nInstructions\n');
  fireEvent.click(within(h.container).getByRole('button', { name: t('settings.tabs.skills') }));
  expect(await within(h.container).findByText('local')).toBeDefined();
  fireEvent.click(within(h.container).getByRole('button', { name: t('settings.tabs.skills') }));
  expect(within(h.container).getAllByText('local')).toHaveLength(1);
  expect(h.getAdapter).toHaveBeenCalledTimes(1);
});

it('persists dual-pane changes before rerendering the available display controls', async () => {
  const h = await createSettings({ enableDualPane: true });
  expect(within(h.container).getByText(t('settings.dualPaneSide.name'))).toBeDefined();
  const initialToggle = within(h.container).getByRole('switch', { name: t('settings.enableDualPane.name') });
  fireEvent.click(initialToggle);
  await controlChangeSettled(initialToggle);
  expect(within(h.container).queryByText(t('settings.dualPaneSide.name'))).toBeNull();
  expect((await h.storage.load()).enableDualPane).toBe(false);
  expect(within(h.container).getByRole('switch', { name: t('settings.restoreTabsOnStartup.name') })).toBeDefined();
  // Query the rerendered control rather than a detached old checkbox.
  const currentToggle = within(h.container).getByRole('switch', { name: t('settings.enableDualPane.name') });
  fireEvent.click(currentToggle);
  await controlChangeSettled(currentToggle);
  expect(within(h.container).getByText(t('settings.dualPaneSide.name'))).toBeDefined();
  expect((await h.storage.load()).enableDualPane).toBe(true);
});

it.each([
  ['restoreTabsOnStartup', 'settings.restoreTabsOnStartup.name'],
  ['enableZenMode', 'settings.enableZenMode.name'],
] as const)('persists the %s toggle through the settings owner', async (key, label) => {
  const h = await createSettings();
  expect(h.settings[key]).toBe(true);
  const toggle = within(h.container).getByRole('switch', { name: t(label) });
  fireEvent.click(toggle);
  await controlChangeSettled(toggle);
  expect(h.settings[key]).toBe(false);
  expect((await h.storage.load())[key]).toBe(false);
});

it('publishes timestamp preferences only after persistence completes', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const h = await createSettings({ showMessageTimestamps: false }, () => { started(); return gate; });
  const toggle = within(h.container).getByRole('switch', { name: t('settings.showMessageTimestamps.name') });
  fireEvent.click(toggle);
  try {
    await writing;
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.settings.showMessageTimestamps).toBe(false);
  } finally { finish(); }
  await controlChangeSettled(toggle);
  expect(h.settings.showMessageTimestamps).toBe(true);
  expect((await h.storage.load()).showMessageTimestamps).toBe(true);
});

it('batches text changes and durably flushes the last draft on teardown', async () => {
  let published!: () => void;
  const lastDraftPublished = new Promise<void>(resolve => { published = resolve; });
  const h = await createSettings({}, undefined, settings => {
    if (settings.userName === 'Last edit') published();
  });
  const row = within(h.container).getByRole('textbox', { name: t('settings.userName.name') }).closest<HTMLElement>('.setting-item')!;
  const input = within(row).getByRole('textbox');
  vi.useFakeTimers();
  for (let index = 0; index < 20; index++) fireEvent.input(input, { target: { value: `Name ${index}` } });
  expect(h.persist).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  await h.mutations.mock.results.at(-1)!.value;
  expect(h.settings.userName).toBe('Name 19');
  expect(h.persist).toHaveBeenCalledTimes(1);
  // Keep the debounce clock frozen so only disposal can publish this draft.
  fireEvent.input(input, { target: { value: 'Last edit' } });
  h.dispose();
  await lastDraftPublished;
  expect(h.settings.userName).toBe('Last edit');
  expect((await h.storage.load()).userName).toBe('Last edit');
  expect(h.persist).toHaveBeenCalledTimes(2);
});

it('updates title eligibility from real provider catalogs after selection and catalog changes', async () => {
  const h = await createSettings({ enableAutoTitleGeneration: true, titleGenerationModel: '' });
  const ui = within(h.container);
  expect(ui.getByRole('status').textContent).toBe(t('settings.titleModel.unavailableWarning'));
  const menu = ui.getByRole<HTMLSelectElement>('combobox', { name: t('settings.titleModel.name') });
  expect(within(menu).queryByRole('option', { name: /Auto/ })).toBeNull();
  expect(menu.value).toBe('');
  expect(menu.options[0].disabled).toBe(true);
  expect(menu.required).toBe(true);
  expect(h.persist).not.toHaveBeenCalled();
  expect(await axe(menu.parentElement!)).toHaveNoViolations();
  fireEvent.change(menu, { target: { value: 'sonnet' } });
  await controlChangeSettled(menu);
  expect(ui.queryByRole('status')).toBeNull();
  expect((await h.storage.load()).titleGenerationModel).toBe('sonnet');
  updateClaudeProviderSettings(h.settings, { visibleModels: [] });
  h.tab.refreshModelOptions();
  expect(ui.getByRole('status').textContent).toBe(t('settings.titleModel.unavailableWarning'));
  updateClaudeProviderSettings(h.settings, { visibleModels: ['sonnet'] });
  h.tab.refreshModelOptions();
  expect(ui.queryByRole('status')).toBeNull();
  expect(await axe(menu.parentElement!)).toHaveNoViolations();
});

it('omits title guidance while automatic titles are disabled', async () => {
  const h = await createSettings();
  expect(within(h.container).getByRole('switch', { name: t('settings.autoTitle.name') })).toBeDefined();
  expect(within(h.container).queryByRole('status')).toBeNull();
});

it('lazily initializes provider services once and reuses their settings without changing chat selection', async () => {
  const h = await createSettings();
  const original = structuredClone(h.settings);
  for (const provider of h.providers) expect(provider.initialize).not.toHaveBeenCalled();
  fireEvent.click(within(h.container).getByRole('button', { name: t('settings.tabs.providers') }));
  await within(h.container).findByText('claude settings loaded');
  const first = within(h.container).getByText('claude settings loaded');
  fireEvent.click(within(h.container).getByRole('button', { name: 'Codex' }));
  await within(h.container).findByText('codex settings loaded');
  fireEvent.click(within(h.container).getByRole('button', { name: 'Claude Code' }));
  expect(within(h.container).getByText('claude settings loaded')).toBe(first);
  for (const provider of h.providers) {
    expect(provider.initialize).toHaveBeenCalledTimes(1);
    expect(provider.render).toHaveBeenCalledTimes(1);
  }
  expect(h.persist).not.toHaveBeenCalled();
  expect(h.settings).toEqual(original);
});

it('updates a disabled provider surface from its committed enablement notification', async () => {
  const h = await createSettings({
    settingsProvider: 'codex', providerConfigs: { codex: { enabled: false } },
    enableAutoTitleGeneration: true, titleGenerationModel: 'openai-codex/gpt-5.5',
  });
  const titleModels = within(h.container).getByRole('combobox', { name: t('settings.titleModel.name') });
  expect(within(titleModels).queryByRole('option', { name: 'Codex: GPT-5.5' })).toBeNull();
  expect(within(h.container).getByRole('status').textContent).toBe(t('settings.titleModel.unavailableWarning'));
  fireEvent.click(within(h.container).getByRole('button', { name: t('settings.tabs.providers') }));
  const label = await within(h.container).findByText('codex settings loaded');
  const content = label.closest<HTMLElement>('.claudian-settings-provider-content')!;
  expect(content.classList.contains('claudian-settings-provider-content--disabled')).toBe(true);
  const enable = within(content).getByRole('button', { name: 'Enable codex' });
  fireEvent.click(enable);
  await controlChangeSettled(enable);
  expect(content.classList.contains('claudian-settings-provider-content--disabled')).toBe(false);
  expect((await h.storage.load()).providerConfigs.codex?.enabled).toBe(true);
  expect(h.notifications).toEqual(['codex']);
  expect(within(titleModels).getByRole('option', { name: 'Codex: GPT-5.5' })).toBeDefined();
  expect(within(h.container).queryByRole('status')).toBeNull();
});
