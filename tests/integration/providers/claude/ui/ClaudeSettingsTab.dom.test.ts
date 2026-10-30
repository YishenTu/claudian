/** @vitest-environment jsdom */
import '@/providers';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderSettingsTabRenderHandle } from '@/core/providers/types';
import { t } from '@/i18n/i18n';
import { type ClaudeWorkspaceServices,createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import type { ClaudeCatalogProbe } from '@/providers/claude/runtime/ClaudeModels';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';

const models = [{ value: 'opus', label: 'Opus', description: '' }, { value: 'claude-opus-4-6', label: 'Opus 4.6', description: '' }];
let fixture: Awaited<ReturnType<typeof createProviderHostFixture>>;
let services: ClaudeWorkspaceServices;
let control: ProviderSettingsTabRenderHandle | void;
let container: HTMLElement;
let probe: ReturnType<typeof vi.fn<ClaudeCatalogProbe>>;
let notify: ReturnType<typeof vi.fn<(providerId: string) => void>>;

beforeEach(async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  document.body.innerHTML = '<style>.claudian-hidden { display: none; }</style>';
  container = document.body.createEl('main');
  fixture = await createProviderHostFixture({ settings: {
    model: 'claude-opus-4-6',
    providerConfigs: { claude: { enabled: true, discoveredModels: models, visibleModels: ['opus', 'claude-opus-4-6'] }, pi: { enabled: true } },
  } });
  probe = vi.fn(async () => ({ models, outputStyles: [] }));
  notify = vi.fn();
  services = await createClaudeWorkspaceServices(fixture.host, { catalogProbe: probe });
});
afterEach(async () => {
  control?.dispose();
  control = undefined;
  await services.dispose();
  await fixture.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function render() {
  const contextLimits = vi.fn((target: HTMLElement, provider: string) => {
    target.createEl('output', { attr: { 'aria-label': `${provider} custom context limits` } });
  });
  control = services.settingsTabRenderer!.render(container, {
    plugin: fixture.host, notifyProviderModelOptionsChanged: notify, renderCustomContextLimits: contextLimits,
  });
  await services.modelCatalog!.refresh();
  return contextLimits;
}

async function toggle(name: string, checked: boolean) {
  const input = within(container).getByRole<HTMLInputElement>('switch', { name });
  fireEvent.change(input, { target: { checked } });
  await controlChangeSettled(input);
  return input;
}
function cliInput() {
  const disclosure = within(container).getByRole('button', { name: 'Claude Code installation' });
  if (disclosure.getAttribute('aria-expanded') === 'false') fireEvent.click(disclosure);
  return within(container).getByRole<HTMLInputElement>('textbox', { name: t('settings.cliPath.name') });
}
async function commitCLI(value: string) {
  const input = cliInput();
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(input.disabled).toBe(false));
}
async function storedConfig() {
  return getClaudeProviderSettings(await fixture.settingsStorage.load());
}

it('offers default-off prompt suggestions in Responses and durably persists changes', async () => {
  await render();
  const responses = within(container).getByRole('heading', { name: t('settings.responses') });
  const input = within(container).getByRole<HTMLInputElement>('switch', { name: t('settings.claude.promptSuggestions.name') });
  const configuration = within(container).getByRole('heading', { name: t('settings.claude.configuration') });
  expect(responses.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(input.compareDocumentPosition(configuration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(input.checked).toBe(false);
  await toggle(t('settings.claude.promptSuggestions.name'), true);
  expect((await storedConfig()).promptSuggestions).toBe(true);
});

it.each([false, true])('clears legacy and host CLI overrides when restoring automatic detection (host override: %s)', async hasHostOverride => {
  const key = fixture.storage.installationKey;
  updateClaudeProviderSettings(fixture.settings, {
    cliPath: '/legacy/claude', cliPathsByHost: { 'other-host': '/keep/claude', ...(hasHostOverride ? { [key]: '/host/claude' } : {}) },
  });
  await render();
  expect(cliInput().value).toBe(hasHostOverride ? '/host/claude' : '/legacy/claude');
  await commitCLI('');
  expect((await storedConfig()).cliPath).toBe('');
  expect(getClaudeProviderSettings(fixture.settings).cliPathsByHost).toEqual({ 'other-host': '/keep/claude' });
});

it('offers discovered output styles, keeps a saved unlisted style, and durably persists inheritance', async () => {
  updateClaudeProviderSettings(fixture.settings, { outputStyle: 'Retired Style', discoveredOutputStyles: ['default', 'Concise', 'My Style'] });
  await render();
  const select = within(container).getByRole<HTMLSelectElement>('combobox', { name: 'Response style' });
  expect(within(select).getAllByRole('option').map(option => option.textContent))
    .toEqual(['Claude Code setting', 'Default', 'Concise', 'My Style', 'Retired Style']);
  expect(select.value).toBe('Retired Style');
  for (const [name, stored] of [['My Style', 'My Style'], ['Default', 'default'], ['Claude Code setting', null]] as const) {
    const option = within(select).getByRole<HTMLOptionElement>('option', { name });
    fireEvent.change(select, { target: { value: option.value } });
    await controlChangeSettled(select);
    expect((await storedConfig()).outputStyle).toBe(stored);
  }
  expect(await axe(container)).toHaveNoViolations();
});

it('rebuilds response-style choices after real catalog discovery publishes a new list', async () => {
  await render();
  const select = within(container).getByRole<HTMLSelectElement>('combobox', { name: 'Response style' });
  expect([...select.options].map(option => option.value)).toEqual(['']);
  probe.mockResolvedValue({ models, outputStyles: ['default', 'Proactive'] });
  await services.modelCatalog!.refresh({ force: true });
  expect([...select.options].map(option => option.value)).toEqual(['', 'default', 'Proactive']);
  expect((await storedConfig()).discoveredOutputStyles).toEqual(['default', 'Proactive']);
});

it('persists enablement inside the real execution transition without starting discovery', async () => {
  await render();
  const values: boolean[] = [];
  fixture.lifecycle.registerTransitionHook('claude', {
    beforeTransition: () => { values.push(getClaudeProviderSettings(fixture.settings).enabled); },
    afterTransition: () => { values.push(getClaudeProviderSettings(fixture.settings).enabled); },
  });
  await toggle('Enable Claude Code', false);
  expect((await storedConfig()).enabled).toBe(false);
  await toggle('Enable Claude Code', true);
  expect((await storedConfig()).enabled).toBe(true);
  expect(values).toEqual([true, false, false, true]);
  expect(probe).toHaveBeenCalledTimes(1); // Rendering discovers once; transitions must not probe again.
  expect(notify).toHaveBeenCalledWith('claude');
});

it('rejects disabling the last provider and shows the real warning', async () => {
  for (const id of ProviderRegistry.getRegisteredProviderIds()) ProviderRegistry.setEnabled(id, fixture.settings, id === 'claude');
  await render();
  const before = vi.fn();
  fixture.lifecycle.registerTransitionHook('claude', { beforeTransition: before });
  await toggle('Enable Claude Code', false);
  expect(getClaudeProviderSettings(fixture.settings).enabled).toBe(true);
  expect(within(container).getByRole<HTMLInputElement>('switch', { name: 'Enable Claude Code' }).checked).toBe(true);
  expect(getComputedStyle(within(container).getByText(t('settings.providerEnablement.lastProviderWarning'))).display).not.toBe('none');
  expect(before).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

it.each([false, true])('validates and persists a CLI path inside the real execution transition (quoted: %s)', async quoted => {
  const executable = path.join(fixture.vault.root, 'custom dir', 'claude');
  await fs.mkdir(path.dirname(executable));
  await fs.writeFile(executable, '#!/bin/sh\n');
  const reset = vi.spyOn(services.cliResolver, 'reset');
  await render();
  await commitCLI(path.join(fixture.vault.root, 'missing'));
  expect(cliInput().getAttribute('aria-invalid')).toBe('true');
  expect(reset).not.toHaveBeenCalled();
  const values: Array<string | undefined> = [];
  const key = fixture.storage.installationKey;
  fixture.lifecycle.registerTransitionHook('claude', {
    beforeTransition: () => { values.push(getClaudeProviderSettings(fixture.settings).cliPathsByHost[key]); },
    afterTransition: () => {
      values.push(getClaudeProviderSettings(fixture.settings).cliPathsByHost[key]);
      expect(reset).toHaveBeenCalledTimes(1);
    },
  });
  const configured = quoted ? `"${executable}"` : executable;
  await commitCLI(configured);
  expect(values).toEqual([undefined, configured]);
  expect((await storedConfig()).cliPathsByHost[key]).toBe(configured);
});

it('updates the no-model warning through selection, discovery, and provider disablement', async () => {
  updateClaudeProviderSettings(fixture.settings, { visibleModels: [] });
  await render();
  const warning = within(container).getByText(t('settings.providerEnablement.noModelsWarning', { provider: 'Claude Code' }));
  expect(getComputedStyle(warning).display).not.toBe('none');
  await services.modelCatalog!.changeSelection({ type: 'set', modelId: 'opus', selected: true });
  expect(getComputedStyle(warning).display).toBe('none');
  probe.mockResolvedValue({ models: [], outputStyles: [] });
  await services.modelCatalog!.refresh({ force: true });
  expect(getComputedStyle(warning).display).not.toBe('none');
  await toggle('Enable Claude Code', false);
  expect(getComputedStyle(warning).display).toBe('none');
});

it('renders accessible provider controls and scopes environment context limits to Claude', async () => {
  const contextLimits = await render();
  expect(within(container).getByRole('heading', { name: 'Models' })).toBeTruthy();
  expect(within(container).getByRole('combobox', { name: 'Response style' })).toBeTruthy();
  expect(cliInput().placeholder).toContain('cli-wrapper.cjs');
  expect(cliInput().placeholder).not.toContain('cli.js');
  expect(contextLimits).toHaveBeenCalledWith(expect.any(HTMLElement), 'claude');
  expect(within(container).getByRole('status', { name: 'claude custom context limits' })).toBeTruthy();
  const forbidden = /slash commands|hidden commands|agent skills|enable opus.*1m|enable sonnet.*1m|default model|custom models/i;
  const controls = () => ['button', 'switch', 'textbox', 'combobox', 'heading'].flatMap(role =>
    within(container).queryAllByRole(role, { name: forbidden }));
  expect(controls()).toEqual([]);
  const injected = container.createEl('button', { text: 'Agent skills', attr: { type: 'button' } });
  expect(controls()).toEqual([injected]);
  injected.remove();
  expect(await axe(container)).toHaveNoViolations();
});
